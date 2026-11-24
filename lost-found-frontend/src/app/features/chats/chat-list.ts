import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { initialsOf } from '../../core/auth/auth.service';
import { ChatStore } from '../../core/state/chat.store';
import { ItemsStore } from '../../core/state/items.store';
import { TimeAgoPipe } from '../../shared/pipes/time.pipes';
import { Avatar } from '../../shared/ui/avatar';

/** All my conversations, newest first. */
@Component({
  selector: 'app-chat-list',
  imports: [RouterLink, Avatar, TimeAgoPipe],
  template: `
    <h1 class="title">Chats</h1>

    <ul class="list">
      @for (row of rows(); track row.id) {
        <li>
          <a class="row" [routerLink]="['/chats', row.id]">
            <app-avatar [initials]="row.other?.initials ?? '?'" tone="amber" [size]="36" />
            <div class="text">
              <p class="name">
                {{ row.other?.name ?? 'Someone' }}
                <span class="mono">· {{ row.itemTitle }} · Nº {{ row.itemNo }}</span>
              </p>
              <p class="last">{{ row.last?.text ?? 'No messages yet' }}</p>
            </div>
            <div class="side">
              <span class="mono">{{ row.last?.at | timeAgo }}</span>
              @if (row.unread) {
                <span class="unread" aria-label="unread"></span>
              }
            </div>
          </a>
          <button
            type="button"
            class="delete"
            [attr.aria-label]="'Delete chat with ' + (row.other?.name ?? 'someone')"
            title="Delete chat"
            (click)="deleteChat(row.id)"
          >
            ×
          </button>
        </li>
      } @empty {
        <li class="empty">
          @if (loaded()) {
            No chats yet. Open an item and tap “This is mine” to message the finder.
          } @else {
            Loading chats…
          }
        </li>
      }
    </ul>
  `,
  styleUrl: './chat-list.scss',
})
export class ChatList {
  private readonly chat = inject(ChatStore);
  private readonly items = inject(ItemsStore);

  protected readonly loaded = this.chat.loaded;

  /** A "view model": everything the template needs, precomputed. */
  protected readonly rows = computed(() => {
    return this.chat.threads().map((t) => {
      return {
        id: t.id,
        itemNo: t.itemNo || '…',
        itemTitle: this.items.byNo(t.itemNo)?.title ?? 'Item',
        other: { name: t.otherName, initials: initialsOf(t.otherName) },
        last: t.messages.at(-1),
        unread: this.chat.isUnread(t),
      };
    });
  });

  protected async deleteChat(id: string): Promise<void> {
    if (!confirm('Delete this chat from your list? The other person will still see it.')) return;
    try {
      await this.chat.remove(id);
    } catch {
      alert('Could not delete the chat. Please try again.');
    }
  }
}
