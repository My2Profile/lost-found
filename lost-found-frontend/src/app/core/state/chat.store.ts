import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiError } from '../api/api-error.interceptor';
import { ApiChatEvent, ApiChatMessage, ChatApiService } from '../api/chat-api.service';
import { AuthService, initialsOf } from '../auth/auth.service';
import { ChatMessage, Item } from '../models/models';
import { ItemsStore } from './items.store';

/** How often the conversation list (unread badges) is refreshed. */
const LIST_POLL_MS = 15_000;
/** Reconnect back-off: 1 s, 2 s, 4 s ... up to 30 s. */
const MAX_BACKOFF_MS = 30_000;
const HISTORY_PAGE = 50;
/** After a reconnect, page back at most this many pages to find missed messages. */
const MAX_CATCH_UP_PAGES = 5;
const SEND_ATTEMPTS = 3;

/** One conversation between the finder and one person who thinks the item is theirs. */
export interface Conversation {
  id: string;
  itemId: string;
  /** "0413". Empty until the listing is loaded. */
  itemNo: string;
  /** [me, the other person] */
  participants: string[];
  otherName: string;
  /** Oldest first. */
  messages: ChatMessage[];
  unread: number;
  createdAt: string;
}

/**
 * Chat backed by the API (Sprint 3, US-03/US-04):
 *  - the list and unread counts come from GET /api/conversations (polled);
 *  - sending is HTTP POST with a clientMessageId, reused on retry, so a retry never duplicates;
 *  - an open conversation gets live messages over a WebSocket (one-time ticket),
 *    reconnects with back-off and reloads the history it missed, merged by message id.
 */
@Injectable({ providedIn: 'root' })
export class ChatStore {
  private readonly api = inject(ChatApiService);
  private readonly auth = inject(AuthService);
  private readonly itemsStore = inject(ItemsStore);

  private readonly convs = signal<Record<string, Conversation>>({});
  /** True after the first list load, so pages can tell "loading" from "doesn't exist". */
  readonly loaded = signal(false);

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** Conversations a page is showing right now. */
  private readonly active = new Map<string, number>();
  private readonly sockets = new Map<string, WebSocket>();
  /** Waiting for a ticket: stops parallel connects for the same conversation. */
  private readonly connecting = new Set<string>();
  private readonly attempts = new Map<string, number>();
  private readonly reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Incoming message ids already sent to POST /read. */
  private readonly acked = new Set<string>();
  private readonly resolving = new Set<string>();

  constructor() {
    effect(() => {
      const me = this.auth.currentUser()?.id;
      untracked(() => {
        this.reset();
        if (!me) return;
        void this.refresh();
        this.pollTimer = setInterval(() => void this.refresh(), LIST_POLL_MS);
      });
    });

    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      void this.refresh();
      for (const id of this.active.keys()) this.markRead(id);
    };
    document.addEventListener('visibilitychange', onVisible);
    inject(DestroyRef).onDestroy(() => {
      document.removeEventListener('visibilitychange', onVisible);
      this.reset();
    });
  }

  /** My conversations, most recent activity first. */
  readonly threads = computed(() => {
    const byId = new Map(this.itemsStore.items().map((i) => [i.id, i.no]));
    return Object.values(this.convs())
      .map((c) => (c.itemNo ? c : { ...c, itemNo: byId.get(c.itemId) ?? '' }))
      .sort((a, b) => lastActivity(b) - lastActivity(a));
  });

  /** How many conversations have unread messages (badge in the nav). */
  readonly unreadCount = computed(() => this.threads().filter((t) => t.unread > 0).length);

  byId(id: string): Conversation | undefined {
    return this.threads().find((t) => t.id === id);
  }

  /** The current user's conversation about an item, if one exists. */
  forItem(itemNo: string): Conversation | undefined {
    return this.threads().find((t) => t.itemNo === itemNo);
  }

  isUnread(thread: Conversation): boolean {
    return thread.unread > 0;
  }

  /** "This is mine · Message finder": the API returns the existing conversation or makes one. */
  async openOrCreate(item: Item): Promise<Conversation> {
    const me = this.auth.currentUser();
    if (!me) throw new Error('Not signed in');
    if (!item.id) throw new Error('This listing is not saved yet');

    const res = await firstValueFrom(this.api.open(item.id));
    const otherId = res.ownerUserId === me.id ? res.initiatorUserId : res.ownerUserId;
    const existing = this.convs()[res.id];
    const conv: Conversation = existing ?? {
      id: res.id,
      itemId: res.foundItemId,
      itemNo: item.no,
      participants: [me.id, otherId],
      otherName: item.finderName ?? 'Finder',
      messages: [],
      unread: 0,
      createdAt: res.createdAt,
    };
    this.convs.update((all) => ({ ...all, [conv.id]: conv }));
    return conv;
  }

  /** A page started showing this conversation: load history and go live. */
  open(id: string): void {
    this.active.set(id, (this.active.get(id) ?? 0) + 1);
    if (this.active.get(id) === 1) {
      void this.loadHistory(id);
      void this.connect(id);
    }
  }

  /** The page closed. Call once per open(). */
  close(id: string): void {
    const count = (this.active.get(id) ?? 1) - 1;
    if (count > 0) {
      this.active.set(id, count);
      return;
    }
    this.active.delete(id);
    this.disconnect(id);
  }

  async send(threadId: string, text: string): Promise<void> {
    const me = this.auth.currentUser();
    const body = text.trim();
    if (!me || !body) return;

    const clientId = newUuid();
    const draft: ChatMessage = {
      from: me.id,
      text: body,
      at: new Date().toISOString(),
      clientId,
      pending: true,
    };
    this.patchMessages(threadId, [draft]);

    for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
      try {
        const saved = await firstValueFrom(this.api.send(threadId, clientId, body));
        this.patchMessages(threadId, [fromApi(saved)]);
        return;
      } catch (error) {
        // 4xx (except timeout / rate limit) will fail the same way again.
        const status = error instanceof ApiError ? error.status : 0;
        if (status === 409) {
          // Most likely the item was returned and the chat closed.
          const itemId = this.convs()[threadId]?.itemId;
          if (itemId) void this.itemsStore.reloadById(itemId);
        }
        const retryable = status === 0 || status >= 500 || status === 408 || status === 429;
        if (!retryable || attempt === SEND_ATTEMPTS) break;
        await sleep(1000 * attempt);
      }
    }
    this.patchMessages(threadId, [{ ...draft, pending: false, failed: true }]);
  }

  /** Tell the API which incoming messages the user has seen. */
  markRead(threadId: string): void {
    const me = this.auth.currentUser()?.id;
    const conv = this.convs()[threadId];
    if (!me || !conv) return;

    const ids = conv.messages
      .filter((m) => m.from !== me && m.id && !this.acked.has(m.id))
      .map((m) => m.id as string);
    if (conv.unread > 0) this.setUnread(threadId, 0);
    if (ids.length === 0) return;

    ids.forEach((id) => this.acked.add(id));
    for (let i = 0; i < ids.length; i += 100) {
      this.api.markRead(threadId, ids.slice(i, i + 100)).subscribe({
        error: () => ids.slice(i, i + 100).forEach((id) => this.acked.delete(id)),
      });
    }
  }

  /** Reload the conversation list and unread counts. */
  async refresh(): Promise<void> {
    const me = this.auth.currentUser();
    if (!me) return;
    try {
      const page = await firstValueFrom(this.api.list());
      if (this.auth.currentUser()?.id !== me.id) return;

      const prev = this.convs();
      const next: Record<string, Conversation> = { ...prev };
      const stale: string[] = [];

      for (const row of page.items) {
        const old = prev[row.id];
        const live = this.sockets.get(row.id)?.readyState === WebSocket.OPEN;
        next[row.id] = {
          id: row.id,
          itemId: row.foundItemId,
          itemNo: old?.itemNo ?? '',
          participants: [me.id, row.otherUserId],
          otherName: row.otherUserName || old?.otherName || 'Student',
          messages: old?.messages ?? [],
          unread: this.active.has(row.id) ? 0 : row.unreadCount,
          createdAt: row.createdAt,
        };
        // New conversation, or new messages we don't have yet: fetch them for the preview.
        if (!old || (!live && row.unreadCount !== old.unread)) stale.push(row.id);
        this.rememberPerson(row.otherUserId, next[row.id].otherName);
        void this.resolveItem(row.foundItemId);
      }

      this.convs.set(next);
      this.loaded.set(true);
      stale.forEach((id) => void this.loadHistory(id));
      // The item may have been returned meanwhile: that closes the chat.
      for (const id of this.active.keys()) {
        const itemId = next[id]?.itemId;
        if (itemId) void this.itemsStore.reloadById(itemId);
      }
    } catch {
      // Keep what we have; the next poll tries again.
      this.loaded.set(true);
    }
  }

  // ---- internals ----

  /** Newest page, then older pages until we reach messages we already have. */
  private async loadHistory(id: string): Promise<void> {
    try {
      const known = new Set(
        (this.convs()[id]?.messages ?? []).map((m) => m.id).filter((x): x is string => !!x),
      );
      let before: string | undefined;
      for (let page = 0; page < MAX_CATCH_UP_PAGES; page++) {
        const res = await firstValueFrom(this.api.history(id, HISTORY_PAGE, before));
        const batch = res.items.map(fromApi);
        this.patchMessages(id, batch);
        const reachedKnown = known.size === 0 || batch.some((m) => m.id && known.has(m.id));
        if (!res.nextBefore || reachedKnown) break;
        before = res.nextBefore;
      }
      if (this.active.has(id) && document.visibilityState === 'visible') this.markRead(id);
    } catch {
      /* the list poll or the next reconnect retries */
    }
  }

  private async connect(id: string): Promise<void> {
    if (!this.active.has(id) || this.sockets.has(id) || this.connecting.has(id)) return;
    this.connecting.add(id);
    try {
      const { ticket } = await firstValueFrom(this.api.ticket(id));
      if (!this.active.has(id) || this.sockets.has(id)) return;

      const socket = new WebSocket(this.api.socketUrl(id, ticket));
      this.sockets.set(id, socket);

      socket.onmessage = (event) => {
        let data: ApiChatEvent;
        try {
          data = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (data.type === 'ready') {
          this.attempts.set(id, 0);
          void this.loadHistory(id); // whatever arrived while we were offline
        } else if (data.type === 'message') {
          this.receive(id, data.message);
        }
      };
      socket.onclose = () => {
        if (this.sockets.get(id) === socket) this.sockets.delete(id);
        this.scheduleReconnect(id);
      };
    } catch (error) {
      // Not a participant / conversation gone: don't hammer the API.
      if (error instanceof ApiError && (error.status === 404 || error.status === 403)) return;
      this.scheduleReconnect(id);
    } finally {
      this.connecting.delete(id);
    }
  }

  private scheduleReconnect(id: string): void {
    if (!this.active.has(id) || this.reconnectTimers.has(id)) return;
    const attempt = (this.attempts.get(id) ?? 0) + 1;
    this.attempts.set(id, attempt);
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (attempt - 1)) + Math.random() * 500;
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(id);
      void this.connect(id);
    }, delay);
    this.reconnectTimers.set(id, timer);
  }

  private disconnect(id: string): void {
    const timer = this.reconnectTimers.get(id);
    if (timer) clearTimeout(timer);
    this.reconnectTimers.delete(id);
    this.attempts.delete(id);
    const socket = this.sockets.get(id);
    this.sockets.delete(id);
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
  }

  private receive(id: string, message: ApiChatMessage): void {
    const msg = fromApi(message);
    this.patchMessages(id, [msg]);
    const me = this.auth.currentUser()?.id;
    if (msg.from === me) return;
    if (this.active.has(id) && document.visibilityState === 'visible') this.markRead(id);
    else this.setUnread(id, (this.convs()[id]?.unread ?? 0) + 1);
  }

  /** Merge by message id; a server copy replaces the local draft with the same clientMessageId. */
  private patchMessages(id: string, incoming: ChatMessage[]): void {
    this.convs.update((all) => {
      const conv = all[id];
      if (!conv) return all;
      return { ...all, [id]: { ...conv, messages: mergeMessages(conv.messages, incoming) } };
    });
  }

  private setUnread(id: string, unread: number): void {
    this.convs.update((all) => (all[id] ? { ...all, [id]: { ...all[id], unread } } : all));
  }

  private rememberPerson(id: string, name: string): void {
    const known = this.auth.users().find((u) => u.id === id);
    if (known && known.name === name) return;
    this.auth.remember({
      id,
      name,
      email: known?.email ?? '',
      initials: initialsOf(name),
      returnedCount: known?.returnedCount ?? 0,
    });
  }

  /** Load the listing so the chat can show its title and Nº. */
  private async resolveItem(itemId: string): Promise<void> {
    if (this.resolving.has(itemId) || this.itemsStore.items().some((i) => i.id === itemId)) return;
    this.resolving.add(itemId);
    try {
      await this.itemsStore.loadById(itemId);
    } finally {
      this.resolving.delete(itemId);
    }
  }

  private reset(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    for (const id of [...this.sockets.keys(), ...this.reconnectTimers.keys()]) this.disconnect(id);
    this.convs.set({});
    this.acked.clear();
    this.loaded.set(false);
  }
}

export function fromApi(m: ApiChatMessage): ChatMessage {
  return {
    id: m.id,
    clientId: m.clientMessageId,
    from: m.senderUserId,
    text: m.text,
    at: m.createdAt,
  };
}

export function mergeMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const key = (m: ChatMessage) => m.id ?? `c:${m.clientId}`;
  const byKey = new Map<string, ChatMessage>();
  for (const m of existing) byKey.set(key(m), m);
  for (const m of incoming) {
    if (m.id && m.clientId) byKey.delete(`c:${m.clientId}`);
    byKey.set(key(m), m);
  }
  return [...byKey.values()].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.id ?? '').localeCompare(b.id ?? ''),
  );
}

function lastActivity(c: Conversation): number {
  return Date.parse(c.messages.at(-1)?.at ?? c.createdAt) || 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function newUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
