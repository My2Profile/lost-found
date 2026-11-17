import {
  Component,
  ElementRef,
  afterRenderEffect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ChatMessage } from '../../core/models/models';

/**
 * Message list + composer. Used in the desktop detail panel (D2) and the
 * mobile chat screen (M4). It doesn't know about stores: messages come in,
 * `send` / `action` events go out. The parent decides what they do.
 */
@Component({
  selector: 'app-chat-thread',
  imports: [FormsModule],
  template: `
    <div class="messages" #scroller>
      @for (message of messages(); track message.id ?? message.clientId ?? $index) {
        @if (message.system) {
          <p class="system">{{ message.text }}</p>
        } @else {
          <p
            class="bubble"
            [class.own]="message.from === meId()"
            [class.pending]="message.pending"
            [class.failed]="message.failed"
          >
            {{ message.text }}
            @if (message.failed) {
              <span class="note">Not sent. Check your connection and try again.</span>
            }
          </p>
        }
      } @empty {
        <p class="empty">{{ emptyText() }}</p>
      }
    </div>

    @if (canWrite()) {
      <form class="composer" (ngSubmit)="submit()">
        <label class="visually-hidden" for="chat-input">Message</label>
        <input
          id="chat-input"
          class="input"
          name="text"
          autocomplete="off"
          [placeholder]="placeholder()"
          [(ngModel)]="draft"
        />
        <div class="actions">
          <button class="btn btn--primary send" type="submit" [disabled]="!draft().trim()">
            <span class="send-label">Send</span><span class="send-icon" aria-hidden="true">↑</span>
          </button>
          @if (actionLabel(); as label) {
            <button class="btn btn--secondary action" type="button" (click)="action.emit()">
              {{ label }}
            </button>
          }
        </div>
      </form>
    } @else if (closedText(); as closed) {
      <p class="closed">{{ closed }}</p>
    } @else if (actionLabel(); as label) {
      <div class="actions actions--only">
        <button class="btn btn--secondary action" type="button" (click)="action.emit()">
          {{ label }}
        </button>
      </div>
    }
  `,
  styleUrl: './chat-thread.scss',
})
export class ChatThread {
  readonly messages = input.required<ChatMessage[]>();
  readonly meId = input.required<string>();
  readonly placeholder = input('Write a message…');
  readonly emptyText = input('No messages yet.');
  readonly canWrite = input(true);
  /** Shown instead of the composer when writing is not possible, e.g. the item was returned. */
  readonly closedText = input<string | null>(null);
  /** Optional second button next to Send, e.g. "Mark as returned" for the finder. */
  readonly actionLabel = input<string | null>(null);
  readonly send = output<string>();
  readonly action = output<void>();

  protected readonly draft = signal('');
  private readonly scroller = viewChild.required<ElementRef<HTMLElement>>('scroller');

  constructor() {
    // Runs after Angular updated the DOM: keep the newest message in view.
    afterRenderEffect(() => {
      this.messages();
      const el = this.scroller().nativeElement;
      el.scrollTop = el.scrollHeight;
    });
  }

  protected submit(): void {
    const text = this.draft().trim();
    if (!text) return;
    this.send.emit(text);
    this.draft.set('');
  }
}
