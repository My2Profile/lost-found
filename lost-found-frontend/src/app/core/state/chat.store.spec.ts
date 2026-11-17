import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import {
  ARUZHAN,
  DANIYAR,
  apiItem,
  flushLists,
  nextRequest,
  settle,
  signInAs,
} from '../../../testing/api-fakes';
import { apiErrorInterceptor } from '../api/api-error.interceptor';
import { ApiChatMessage } from '../api/chat-api.service';
import { authInterceptor } from '../auth/auth.interceptor';
import { ChatStore, mergeMessages } from './chat.store';

const CONV = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function apiMessage(n: number, from: string, overrides: Partial<ApiChatMessage> = {}) {
  return {
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`,
    conversationId: CONV,
    senderUserId: from,
    clientMessageId: `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, '0')}`,
    text: `message ${n}`,
    createdAt: new Date(Date.UTC(2026, 10, 17, 10, n)).toISOString(),
    ...overrides,
  };
}

describe('mergeMessages', () => {
  it('dedupes by id, replaces the local draft and keeps time order', () => {
    const draft = {
      clientId: 'x',
      from: 'me',
      text: 'hi',
      at: '2026-11-17T10:05:00.000Z',
      pending: true,
    };
    const older = { id: '1', from: 'them', text: 'a', at: '2026-11-17T10:01:00.000Z' };
    const merged = mergeMessages(
      [older, draft],
      [{ id: '2', clientId: 'x', from: 'me', text: 'hi', at: '2026-11-17T10:05:01.000Z' }, older],
    );
    expect(merged.map((m) => m.id)).toEqual(['1', '2']);
    expect(merged.some((m) => m.pending)).toBe(false);
  });
});

describe('ChatStore', () => {
  let chat: ChatStore;
  const item = apiItem({ userFoundId: DANIYAR.userId });

  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(withInterceptors([apiErrorInterceptor, authInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    chat = TestBed.inject(ChatStore);
    await signInAs(ARUZHAN);
    await flushLists([item]);

    (await nextRequest((r) => r.url === '/api/conversations' && r.method === 'GET')).flush({
      items: [
        {
          id: CONV,
          foundItemId: item.id,
          otherUserId: DANIYAR.userId,
          createdAt: '2026-11-17T10:00:00.000Z',
          otherUserName: DANIYAR.name,
          unreadCount: 1,
        },
      ],
      totalCount: 1,
      page: 1,
      pageSize: 100,
    });
    (await nextRequest((r) => r.url === `/api/conversations/${CONV}/messages`)).flush({
      items: [apiMessage(2, DANIYAR.userId), apiMessage(1, ARUZHAN.userId)],
      nextBefore: null,
    });
    await settle();
  });

  it('shows the conversation from the API with its item, other person and unread count', () => {
    const [thread] = chat.threads();
    expect(thread.id).toBe(CONV);
    expect(thread.itemNo).toBe(String(item.number).padStart(4, '0'));
    expect(thread.otherName).toBe(DANIYAR.name);
    expect(thread.messages.map((m) => m.text)).toEqual(['message 1', 'message 2']);
    expect(chat.unreadCount()).toBe(1);
  });

  it('marks incoming messages read by message id', async () => {
    chat.markRead(CONV);
    const req = await nextRequest((r) => r.url === `/api/conversations/${CONV}/read`);
    expect(req.request.body).toEqual({ messageIds: [apiMessage(2, DANIYAR.userId).id] });
    req.flush(null);
    expect(chat.unreadCount()).toBe(0);
  });

  it('sends with a clientMessageId and replaces the draft with the saved message', async () => {
    const sending = chat.send(CONV, '  Is it blue?  ');
    const req = await nextRequest(
      (r) => r.url === `/api/conversations/${CONV}/messages` && r.method === 'POST',
    );
    expect(req.request.body.text).toBe('Is it blue?');
    expect(req.request.body.clientMessageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(chat.byId(CONV)?.messages.at(-1)?.pending).toBe(true);

    req.flush(
      apiMessage(3, ARUZHAN.userId, {
        text: 'Is it blue?',
        clientMessageId: req.request.body.clientMessageId,
      }),
    );
    await sending;
    const messages = chat.byId(CONV)!.messages;
    expect(messages).toHaveLength(3);
    expect(messages.at(-1)?.text).toBe('Is it blue?');
    expect(messages.at(-1)?.pending).toBeFalsy();
  });

  it('marks a message failed when the API rejects it', async () => {
    const sending = chat.send(CONV, 'hello');
    (
      await nextRequest(
        (r) => r.url === `/api/conversations/${CONV}/messages` && r.method === 'POST',
      )
    ).flush({ title: 'Conflict' }, { status: 409, statusText: 'Conflict' });
    await sending;
    expect(chat.byId(CONV)?.messages.at(-1)).toMatchObject({ text: 'hello', failed: true });
  });
});
