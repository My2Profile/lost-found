import { Component, computed, effect, inject, input, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService, initialsOf } from '../../core/auth/auth.service';
import { AlertsStore } from '../../core/state/alerts.store';
import { ChatStore } from '../../core/state/chat.store';
import { ItemsStore } from '../../core/state/items.store';
import { Avatar } from '../../shared/ui/avatar';
import { ChatThread } from '../../shared/ui/chat-thread';

/** One conversation (M4). On desktop it's centered in the main column. */
@Component({
  selector: 'app-chat-page',
  imports: [RouterLink, Avatar, ChatThread],
  template: `
    @if (thread(); as thread) {
      <header class="head">
        <a class="back" routerLink="/chats" aria-label="Back to chats">←</a>
        <app-avatar [initials]="other()?.initials ?? '?'" tone="amber" [size]="32" />
        <div class="who">
          <p class="name">{{ other()?.name ?? 'Someone' }}</p>
          <a class="about" [routerLink]="['/item', thread.itemNo]">
            {{ item()?.title ?? 'Item' }} · Nº {{ thread.itemNo || '…' }}
          </a>
        </div>
      </header>

      @if (me(); as me) {
        <app-chat-thread
          class="thread"
          [messages]="thread.messages"
          [meId]="me.id"
          [canWrite]="item()?.status === 'open'"
          [closedText]="
            item()?.status === 'returned' ? 'This item was returned. The chat is closed.' : null
          "
          [placeholder]="'Write to ' + (other()?.name ?? 'them') + '…'"
          emptyText="Say hi, and describe something only the owner would know."
          [actionLabel]="canMarkReturned() ? 'Mark as returned' : null"
          (send)="chat.send(thread.id, $event)"
          (action)="markReturned()"
        />
      }
    } @else if (!chat.loaded()) {
      <p class="missing" aria-busy="true">Loading chat…</p>
    } @else {
      <p class="missing">This chat doesn't exist. <a routerLink="/chats">All chats</a></p>
    }
  `,
  styleUrl: './chat-page.scss',
})
export class ChatPage {
  protected readonly chat = inject(ChatStore);
  private readonly itemsStore = inject(ItemsStore);
  private readonly alerts = inject(AlertsStore);
  private readonly auth = inject(AuthService);

  /** Route param :id */
  readonly id = input.required<string>();

  protected readonly me = this.auth.currentUser;
  protected readonly thread = computed(() => this.chat.byId(this.id()));
  protected readonly item = computed(() => {
    const thread = this.thread();
    return thread ? this.itemsStore.byNo(thread.itemNo) : undefined;
  });
  protected readonly other = computed(() => {
    const thread = this.thread();
    return thread ? { name: thread.otherName, initials: initialsOf(thread.otherName) } : undefined;
  });
  protected readonly canMarkReturned = computed(
    () => this.item()?.status === 'open' && this.item()?.finderId === this.me()?.id,
  );

  constructor() {
    // Load history and go live while this page is open.
    effect((onCleanup) => {
      const id = this.id();
      untracked(() => this.chat.open(id));
      onCleanup(() => this.chat.close(id));
    });

    // The listing gives the title and whether it's still open (can write).
    effect(() => {
      const no = this.thread()?.itemNo;
      if (no) untracked(() => void this.itemsStore.reload(no).catch(() => undefined));
    });

    // Keep the thread marked read while it's open, even as new messages arrive.
    effect(() => {
      const thread = this.thread();
      if (thread) untracked(() => this.chat.markRead(thread.id));
    });

    effect(() => {
      const link = `/chats/${this.id()}`;
      untracked(() =>
        this.alerts
          .notifications()
          .filter((n) => !n.read && n.link === link)
          .forEach((n) => this.alerts.markRead(n)),
      );
    });
  }

  protected async markReturned(): Promise<void> {
    const item = this.item();
    if (item && confirm(`Mark “${item.title}” as returned to ${this.other()?.name ?? 'them'}?`)) {
      try {
        await this.itemsStore.markReturned(item.no);
      } catch (error) {
        alert(error instanceof Error ? error.message : 'Could not mark it as returned.');
      }
    }
  }
}
