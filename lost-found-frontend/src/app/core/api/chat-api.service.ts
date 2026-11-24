import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

// Wire format of the chat API (src/LostAndFound.Api/Features/Chat). camelCase JSON.

/** POST /api/conversations */
export interface ApiConversation {
  id: string;
  foundItemId: string;
  ownerUserId: string;
  initiatorUserId: string;
  createdAt: string;
}

/** One row of GET /api/conversations */
export interface ApiConversationListItem {
  id: string;
  foundItemId: string;
  otherUserId: string;
  createdAt: string;
  otherUserName: string;
  unreadCount: number;
}

export interface ApiConversationList {
  items: ApiConversationListItem[];
  totalCount: number;
  page: number;
  pageSize: number;
}

export interface ApiChatMessage {
  id: string;
  conversationId: string;
  senderUserId: string;
  clientMessageId: string;
  text: string;
  createdAt: string;
}

/** GET /api/conversations/{id}/messages: newest first; pass nextBefore as `before`. */
export interface ApiMessageHistory {
  items: ApiChatMessage[];
  nextBefore: string | null;
}

/** Events on wss://host/api/conversations/{id}/ws */
export type ApiChatEvent = { type: 'ready' } | { type: 'message'; message: ApiChatMessage };

/** Typed client for the chat API. Auth headers come from authInterceptor. */
@Injectable({ providedIn: 'root' })
export class ChatApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiBaseUrl}/conversations`;

  /** Create the conversation for a listing, or get the existing one. */
  open(foundItemId: string): Observable<ApiConversation> {
    return this.http.post<ApiConversation>(this.baseUrl, { foundItemId });
  }

  list(pageSize = 100): Observable<ApiConversationList> {
    return this.http.get<ApiConversationList>(this.baseUrl, {
      params: new HttpParams().set('pageSize', pageSize),
    });
  }

  /** Remove the chat from my list. The other person keeps it until they delete it too. */
  delete(conversationId: string): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/${conversationId}`);
  }

  /** Same clientMessageId on a retry: the API answers 200 with the saved message. */
  send(conversationId: string, clientMessageId: string, text: string): Observable<ApiChatMessage> {
    return this.http.post<ApiChatMessage>(`${this.baseUrl}/${conversationId}/messages`, {
      clientMessageId,
      text,
    });
  }

  history(conversationId: string, limit = 50, before?: string): Observable<ApiMessageHistory> {
    let params = new HttpParams().set('limit', limit);
    if (before) params = params.set('before', before);
    return this.http.get<ApiMessageHistory>(`${this.baseUrl}/${conversationId}/messages`, {
      params,
    });
  }

  /** Message `id`s (not senderUserId / clientMessageId), at most 100 per call. */
  markRead(conversationId: string, messageIds: string[]): Observable<void> {
    return this.http.post<void>(`${this.baseUrl}/${conversationId}/read`, { messageIds });
  }

  ticket(conversationId: string): Observable<{ ticket: string; expiresInSeconds: number }> {
    return this.http.post<{ ticket: string; expiresInSeconds: number }>(
      `${this.baseUrl}/${conversationId}/ws-ticket`,
      null,
    );
  }

  /** ws(s)://<this host>/api/conversations/{id}/ws?ticket=... */
  socketUrl(conversationId: string, ticket: string): string {
    const base = new URL(`${this.baseUrl}/${conversationId}/ws`, window.location.href);
    base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    base.searchParams.set('ticket', ticket);
    return base.toString();
  }
}
