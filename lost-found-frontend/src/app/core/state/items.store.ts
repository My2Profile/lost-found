import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiError } from '../api/api-error.interceptor';
import { ApiFoundItemStatus } from '../api/api.types';
import { ItemsApiService } from '../api/items-api.service';
import { AuthService } from '../auth/auth.service';
import { DbStore } from '../data/db.store';
import { AppNotification, Category, Db, Item, Place } from '../models/models';
import {
  Matchable,
  matchesFilter,
  newId,
  nextItemNo,
  placeLabel,
  searchToFilter,
} from '../util/matching';

/** What the Post form produces. The API fills in number, finder, status. */
export interface ItemDraft {
  title: string;
  category: Category;
  place: Place;
  placeDetail?: string;
  held: string;
  foundAt: string;
  description: string;
  photos: string[];
}

/** Enough for Browse in the MVP. Server-side filters + paging come with US-04. */
const BROWSE_PAGE_SIZE = 100;

/**
 * Items feature store: the one place that knows how items are read and changed.
 * Components inject this; it talks to the API through ItemsApiService.
 *
 * Saved-search matches, chats and notifications still live in the local DbStore
 * until their APIs exist (Sprints 2–3), so post() and markReturned() also update those.
 */
@Injectable({ providedIn: 'root' })
export class ItemsStore {
  private readonly api = inject(ItemsApiService);
  private readonly dbStore = inject(DbStore);
  private readonly auth = inject(AuthService);

  // ---- Server state ----
  private readonly openList = signal<Item[]>([]);
  private readonly myList = signal<Item[]>([]);
  /** Items opened by number that aren't in the lists (e.g. returned, or a shared link). */
  private readonly extra = signal<Item[]>([]);

  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly myPostsLoading = signal(false);

  /** Every item we know, newest data wins, no duplicates. */
  readonly items = computed(() => {
    const byNo = new Map<string, Item>();
    for (const list of [this.extra(), this.myList(), this.openList()]) {
      for (const item of list) byNo.set(item.no, item);
    }
    return [...byNo.values()];
  });

  /** Browse (US-03): open items, newest first (the API already sorts them). */
  readonly openItems = computed(() => this.openList().filter((i) => i.status === 'open'));

  /** Shown on the Post preview. The API assigns the real one. */
  readonly nextNo = computed(() => nextItemNo(this.items()));

  /** Items the current user posted. */
  readonly myPosts = computed(() => [...this.myList()].sort(byNewest));

  /**
   * Items that were returned to the current user. The API doesn't record the owner yet
   * (US-07/US-10, Sprints 2–3), so this stays empty for now.
   */
  readonly gotBack = computed<Item[]>(() => []);

  constructor() {
    // (Re)load whenever the signed-in user changes.
    effect(() => {
      const userId = this.auth.currentUser()?.id;
      untracked(() => (userId ? this.refresh() : this.clear()));
    });
  }

  /** Reload Browse and "Posted by me" from the API. */
  refresh(): void {
    void this.loadOpen();
    void this.loadMine();
  }

  byNo(no: string): Item | undefined {
    return this.items().find((i) => i.no === no);
  }

  /** Make sure item Nº `no` is loaded (detail page). Resolves to undefined if it doesn't exist. */
  async load(no: string): Promise<Item | undefined> {
    const known = this.byNo(no);
    if (known) return known;
    if (!/^\d+$/.test(no)) return undefined;

    try {
      const item = await firstValueFrom(this.api.getByNo(no));
      this.extra.update((list) => [item, ...list.filter((i) => i.no !== item.no)]);
      return item;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  /** Make sure the item with this backend id is loaded (chat list). */
  async loadById(id: string): Promise<Item | undefined> {
    const known = this.items().find((i) => i.id === id);
    if (known) return known;
    try {
      const item = await firstValueFrom(this.api.getById(id));
      this.extra.update((list) => [item, ...list.filter((i) => i.no !== item.no)]);
      return item;
    } catch {
      return undefined;
    }
  }

  /** How many other people's saved searches this draft would notify. */
  countMatchingSearches(draft: Matchable): number {
    const me = this.auth.currentUser()?.id;
    return this.dbStore
      .db()
      .savedSearches.filter(
        (s) => s.on && s.userId !== me && matchesFilter(draft, searchToFilter(s)),
      ).length;
  }

  /**
   * US-02: post a found item. Throws ApiError (with fieldErrors on 400).
   * The new item goes to the top of Browse right away.
   */
  async post(draft: ItemDraft): Promise<Item> {
    let item = await firstValueFrom(this.api.create(draft));

    // One photo per item in the API for now (US-11 adds up to 3).
    // The item is already posted, so a failed upload must not fail the post.
    const [firstPhoto] = draft.photos;
    if (firstPhoto && item.id) {
      try {
        const blob = await (await fetch(firstPhoto)).blob();
        const { photoUrl } = await firstValueFrom(this.api.uploadPhoto(item.id, blob));
        item = { ...item, photos: [photoUrl] };
      } catch {
        /* keep the item without a photo */
      }
    }

    this.openList.update((list) => [item, ...list.filter((i) => i.no !== item.no)]);
    this.myList.update((list) => [item, ...list.filter((i) => i.no !== item.no)]);
    this.dbStore.update((db) => notifyMatches(db, item));
    return item;
  }

  /** Finder only (the API answers 403 otherwise). Closes the item and tells the owner. */
  async markReturned(no: string): Promise<void> {
    const me = this.requireUser();
    const item = this.byNo(no);
    if (!item?.id || item.finderId !== me.id || item.status === 'returned') return;

    await firstValueFrom(this.api.markReturned(item.id));

    const now = new Date().toISOString();
    const thread = this.dbStore.db().threads.find((t) => t.itemNo === no);
    const ownerId = thread?.participants.find((p) => p !== me.id);
    const returned: Item = { ...item, status: 'returned', ownerId, returnedAt: now };
    const replace = (list: Item[]) => list.map((i) => (i.no === no ? returned : i));

    this.openList.update((list) => list.filter((i) => i.no !== no));
    this.myList.update(replace);
    this.extra.update(replace);

    // Local parts (chat system line, owner notification) until the chat API is wired up.
    this.dbStore.update((db) => ({
      ...db,
      users: db.users.map((u) =>
        u.id === me.id ? { ...u, returnedCount: u.returnedCount + 1 } : u,
      ),
      threads: db.threads.map((t) =>
        t.itemNo === no
          ? {
              ...t,
              messages: [
                ...t.messages,
                {
                  from: me.id,
                  text: `${me.name} marked this item as returned`,
                  at: now,
                  system: true,
                },
              ],
            }
          : t,
      ),
      notifications: ownerId
        ? [
            {
              id: newId('n'),
              userId: ownerId,
              title: `${me.name} marked “${item.title}” as returned`,
              sub: `Nº ${item.no}`,
              createdAt: now,
              read: false,
              link: `/item/${item.no}`,
            },
            ...db.notifications,
          ]
        : db.notifications,
    }));
  }

  private async loadOpen(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const page = await firstValueFrom(
        this.api.search({ status: ApiFoundItemStatus.Open, pageSize: BROWSE_PAGE_SIZE }),
      );
      this.openList.set(page.items);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not load items.');
    } finally {
      this.loading.set(false);
    }
  }

  private async loadMine(): Promise<void> {
    this.myPostsLoading.set(true);
    try {
      const page = await firstValueFrom(
        this.api.search({ mine: true, pageSize: BROWSE_PAGE_SIZE }),
      );
      this.myList.set(page.items);
    } catch {
      /* Browse shows the error; the profile just stays empty */
    } finally {
      this.myPostsLoading.set(false);
    }
  }

  private clear(): void {
    this.openList.set([]);
    this.myList.set([]);
    this.extra.set([]);
    this.error.set(null);
  }

  private requireUser() {
    const user = this.auth.currentUser();
    if (!user) throw new Error('Not signed in');
    return user;
  }
}

function byNewest(a: Item, b: Item): number {
  return (b.createdAt ?? b.foundAt).localeCompare(a.createdAt ?? a.foundAt);
}

/** For each saved search (of someone else) that matches, bump its counter and notify. */
function notifyMatches(db: Db, item: Item): Db {
  const matches = db.savedSearches.filter(
    (s) => s.on && s.userId !== item.finderId && matchesFilter(item, searchToFilter(s)),
  );
  if (matches.length === 0) return db;

  const matchedIds = new Set(matches.map((s) => s.id));
  const now = new Date().toISOString();

  return {
    ...db,
    savedSearches: db.savedSearches.map((s) =>
      matchedIds.has(s.id) ? { ...s, newMatches: s.newMatches + 1 } : s,
    ),
    notifications: [
      ...matches.map<AppNotification>((s) => ({
        id: newId('n'),
        userId: s.userId,
        title: `New match for “${s.name}”: ${item.title}`,
        sub: placeLabel(item),
        createdAt: now,
        read: false,
        link: `/item/${item.no}`,
      })),
      ...db.notifications,
    ],
  };
}
