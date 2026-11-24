import { Injectable, computed, effect, inject, untracked } from '@angular/core';
import { AuthService } from '../auth/auth.service';
import { DbStore } from '../data/db.store';
import { AppNotification, Item, ItemFilter, NotifyChannel, SavedSearch } from '../models/models';
import { ItemsStore } from './items.store';
import {
  defaultSearchName,
  matchesFilter,
  newId,
  placeLabel,
  sameFilter,
  searchToFilter,
} from '../util/matching';

/** Searches saved before this feature have no createdAt: look back this far once. */
const LEGACY_LOOKBACK_MS = 7 * 24 * 3600 * 1000;
const MAX_NOTIFIED_PER_SEARCH = 200;

/** Saved searches and notifications of the signed-in user. */
@Injectable({ providedIn: 'root' })
export class AlertsStore {
  private readonly dbStore = inject(DbStore);
  private readonly auth = inject(AuthService);
  private readonly itemsStore = inject(ItemsStore);
  private readonly me = computed(() => this.auth.currentUser()?.id);

  constructor() {
    // Saved searches live in this browser, so matching runs here: every time Browse
    // loads (it refreshes every 30 s), new items are checked against my searches.
    effect(() => {
      const items = this.itemsStore.openItems();
      const me = this.me();
      const searches = this.searches();
      if (!me || items.length === 0 || searches.length === 0) return;
      untracked(() => this.notifyNewMatches(items, me, searches));
    });
  }

  readonly searches = computed(() =>
    this.dbStore.db().savedSearches.filter((s) => s.userId === this.me()),
  );

  readonly notifications = computed(() =>
    this.dbStore
      .db()
      .notifications.filter((n) => n.userId === this.me())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  );

  readonly unreadCount = computed(() => this.notifications().filter((n) => !n.read).length);

  findSaved(filter: ItemFilter): SavedSearch | undefined {
    return this.searches().find((s) => sameFilter(searchToFilter(s), filter));
  }

  /** "Save search & notify me" button: save it, or remove it if it's already saved. */
  toggleSaved(filter: ItemFilter, channel: NotifyChannel = 'PUSH'): void {
    const existing = this.findSaved(filter);
    if (existing) {
      this.remove(existing.id);
      return;
    }
    const me = this.me();
    if (!me) return;

    const search: SavedSearch = {
      id: newId('s'),
      userId: me,
      name: defaultSearchName(filter),
      category: filter.category,
      places: [...filter.places],
      query: filter.query?.trim() || undefined,
      channel,
      on: true,
      newMatches: 0,
      createdAt: new Date().toISOString(),
      notified: [],
    };
    askForBrowserNotifications(channel);
    this.dbStore.update((db) => ({ ...db, savedSearches: [...db.savedSearches, search] }));
  }

  setOn(id: string, on: boolean): void {
    this.patchSearch(id, { on });
  }

  setChannel(id: string, channel: NotifyChannel): void {
    this.patchSearch(id, { channel });
  }

  remove(id: string): void {
    this.dbStore.update((db) => ({
      ...db,
      savedSearches: db.savedSearches.filter((s) => s.id !== id),
    }));
  }

  /** Opened the search: its "N new" counter is seen. */
  clearMatches(id: string): void {
    this.patchSearch(id, { newMatches: 0 });
  }

  markRead(notification: AppNotification): void {
    this.patchNotifications((n) => (n.id === notification.id ? { ...n, read: true } : n));
  }

  markAllRead(): void {
    const me = this.me();
    this.patchNotifications((n) => (n.userId === me ? { ...n, read: true } : n));
  }

  /** New items (posted by someone else, after the search was saved) that match a saved search. */
  private notifyNewMatches(items: Item[], me: string, searches: SavedSearch[]): void {
    const now = Date.now();
    const found: { search: SavedSearch; items: Item[] }[] = [];

    for (const search of searches) {
      if (!search.on) continue;
      const since = search.createdAt ? Date.parse(search.createdAt) : now - LEGACY_LOOKBACK_MS;
      const seen = new Set(search.notified ?? []);
      const fresh = items.filter(
        (item) =>
          item.finderId !== me &&
          !seen.has(item.no) &&
          Date.parse(item.createdAt ?? item.foundAt) > since &&
          matchesFilter(item, searchToFilter(search)),
      );
      if (fresh.length > 0) found.push({ search, items: fresh });
    }
    if (found.length === 0) return;

    const createdAt = new Date().toISOString();
    const notifications: AppNotification[] = found.flatMap(({ search, items }) =>
      items.map((item) => ({
        id: newId('n'),
        userId: me,
        title: `New match for “${search.name}”: ${item.title}`,
        sub: placeLabel(item),
        createdAt,
        read: false,
        link: `/item/${item.no}`,
      })),
    );
    const bySearch = new Map(found.map((f) => [f.search.id, f.items]));

    this.dbStore.update((db) => ({
      ...db,
      savedSearches: db.savedSearches.map((s) => {
        const added = bySearch.get(s.id);
        if (!added) return s;
        const notified = [...(s.notified ?? []), ...added.map((i) => i.no)];
        return {
          ...s,
          // Remember when we started, so legacy searches don't look back again.
          createdAt: s.createdAt ?? new Date(now - LEGACY_LOOKBACK_MS).toISOString(),
          newMatches: s.newMatches + added.length,
          notified: notified.slice(-MAX_NOTIFIED_PER_SEARCH),
        };
      }),
      notifications: [...notifications, ...db.notifications],
    }));

    for (const { search, items } of found) {
      if (search.channel === 'PUSH') showBrowserNotification(search, items);
    }
  }

  private patchSearch(id: string, patch: Partial<SavedSearch>): void {
    this.dbStore.update((db) => ({
      ...db,
      savedSearches: db.savedSearches.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    }));
  }

  private patchNotifications(fn: (n: AppNotification) => AppNotification): void {
    this.dbStore.update((db) => ({ ...db, notifications: db.notifications.map(fn) }));
  }
}

function askForBrowserNotifications(channel: NotifyChannel): void {
  if (channel !== 'PUSH' || typeof Notification === 'undefined') return;
  if (Notification.permission === 'default') void Notification.requestPermission();
}

/** A system notification while the site is open in some tab (no push server). */
function showBrowserNotification(search: SavedSearch, items: Item[]): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const first = items[0];
    const note = new Notification(`New match for “${search.name}”`, {
      body: items.length > 1 ? `${first.title} and ${items.length - 1} more` : first.title,
      tag: `search-${search.id}`,
    });
    note.onclick = () => {
      window.focus();
      window.location.assign(`/item/${first.no}`);
    };
  } catch {
    /* some browsers only allow notifications from a service worker */
  }
}
