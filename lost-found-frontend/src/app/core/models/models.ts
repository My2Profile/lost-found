// Domain model of the frontend (from docs/design/README.md "State / data model").
//
// These are the shapes the UI works with. The backend's DTOs live separately in
// core/api/api.types.ts, and a mapper converts between the two. Keeping them
// apart means a backend rename breaks one mapper, not every component.

export const CATEGORIES = [
  'Electronics',
  'Cards & IDs',
  'Keys',
  'Clothing',
  'Bottles',
  'Books & notes',
  'Other',
] as const;

/** `(typeof X)[number]` turns the readonly array above into a string union type. */
export type Category = (typeof CATEGORIES)[number];
export type CategoryFilter = Category | 'All';

export const PLACES = [
  'Main building',
  'Library',
  'Canteen',
  'Lab block',
  'Sports hall',
  'Dorms',
] as const;
export type Place = (typeof PLACES)[number];

export const HELD_OPTIONS = ['With finder', 'Security desk', 'Library desk'] as const;

export type ItemStatus = 'open' | 'returned';

export interface User {
  id: string;
  name: string;
  email: string;
  initials: string;
  returnedCount: number;
}

export interface Item {
  /** Backend id (GUID). Missing only on the Post form preview. */
  id?: string;
  /** Human-facing number shown as "Nº 0412". Also the URL id: /item/0412. */
  no: string;
  title: string;
  category: Category;
  place: Place;
  placeDetail?: string;
  /** Where the item is now: "With finder", "Security desk", ... */
  held: string;
  /** ISO timestamp. */
  foundAt: string;
  description: string;
  /** Data URLs (Post preview) or API photo URLs. */
  photos: string[];
  /** Short caption shown on the striped placeholder when there is no photo. */
  photoCaption?: string;
  finderId: string;
  /** Finder's display name, from the API. */
  finderName?: string;
  /** When it was posted (ISO). */
  createdAt?: string;
  status: ItemStatus;
  /** Set when the item is marked returned to someone. */
  ownerId?: string;
  returnedAt?: string;
}

export type NotifyChannel = 'PUSH' | 'EMAIL' | 'PUSH + EMAIL';

export interface SavedSearch {
  id: string;
  userId: string;
  name: string;
  category: CategoryFilter;
  places: Place[];
  query?: string;
  channel: NotifyChannel;
  on: boolean;
  newMatches: number;
  /** When it was saved: only items posted after this notify (older ones are already in the list). */
  createdAt?: string;
  /** Item numbers already notified for this search, so each item notifies once. */
  notified?: string[];
}

export interface AppNotification {
  id: string;
  userId: string;
  title: string;
  sub: string;
  createdAt: string;
  read: boolean;
  /** Router link, e.g. "/item/0412". */
  link: string;
}

export interface ChatMessage {
  /** Server message id (missing while a send is in flight). */
  id?: string;
  /** clientMessageId: generated per new message, reused on retry. */
  clientId?: string;
  from: string;
  text: string;
  at: string;
  system?: boolean;
  /** Sent, waiting for the server. */
  pending?: boolean;
  /** Could not be sent after retries. */
  failed?: boolean;
}

export interface Thread {
  id: string;
  itemNo: string;
  participants: string[];
  messages: ChatMessage[];
  /** userId -> ISO time they last opened the thread. Drives unread badges. */
  lastReadAt: Record<string, string>;
}

/** The whole persisted state of the demo. One object in localStorage. */
export interface Db {
  version: number;
  users: User[];
  items: Item[];
  savedSearches: SavedSearch[];
  notifications: AppNotification[];
  threads: Thread[];
}

/** Filters of the Browse page. Also what a saved search stores. */
export interface ItemFilter {
  category: CategoryFilter;
  places: Place[];
  query?: string;
}

export type TimeRange = 'today' | 'week' | 'month';
export type SortOrder = 'newest' | 'oldest';
