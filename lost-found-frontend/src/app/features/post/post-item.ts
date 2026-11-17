import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  AbstractControl,
  NonNullableFormBuilder,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiError } from '../../core/api/api-error.interceptor';
import { FORM_FIELD_FROM_API } from '../../core/api/items-api.mapper';
import { AuthService } from '../../core/auth/auth.service';
import { CATEGORIES, Category, HELD_OPTIONS, Item, PLACES, Place } from '../../core/models/models';
import { ItemsStore } from '../../core/state/items.store';
import { resizeImage, toLocalInputValue } from '../../core/util/image';
import { Photo } from '../../shared/ui/photo';
import { SegmentOption, Segmented } from '../../shared/ui/segmented';
import { TagCard } from '../../shared/ui/tag-card';

const MAX_PHOTOS = 3;

/** Same limits as the backend's CreateFoundItemRequest ([StringLength]). */
export const LIMITS = { title: 150, description: 1024, placeDetail: 60 } as const;

/** Custom validator: a date-time in the future is invalid (the API rejects it too). */
export function notInFuture(control: AbstractControl<string>): ValidationErrors | null {
  const value = control.value ? new Date(control.value).getTime() : NaN;
  return value > Date.now() ? { future: true } : null;
}

/**
 * Post a found item (D3 modal on desktop, M5 full screen on mobile).
 *
 * Typed reactive form: `fb.nonNullable.group` infers the value type from the
 * initial values, so `form.getRawValue().category` is typed `'' | Category`.
 */
@Component({
  selector: 'app-post-item',
  imports: [ReactiveFormsModule, TagCard, Segmented, Photo],
  templateUrl: './post-item.html',
  styleUrl: './post-item.scss',
  host: { '(document:keydown.escape)': 'close()' },
})
export class PostItem {
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly itemsStore = inject(ItemsStore);
  private readonly auth = inject(AuthService);

  protected readonly categories = CATEGORIES;
  protected readonly places = PLACES;
  protected readonly limits = LIMITS;
  protected readonly heldOptions: readonly SegmentOption<string>[] = HELD_OPTIONS.map((h) => ({
    value: h,
    label: h === 'With finder' ? 'With me' : h,
  }));

  protected readonly form = this.fb.group({
    title: ['', [Validators.required, Validators.maxLength(LIMITS.title)]],
    category: ['' as Category | '', Validators.required],
    foundAt: [toLocalInputValue(new Date()), [Validators.required, notInFuture]],
    place: ['' as Place | '', Validators.required],
    placeDetail: ['', Validators.maxLength(LIMITS.placeDetail)],
    description: ['', Validators.maxLength(LIMITS.description)],
    held: ['With finder'],
  });

  protected readonly photos = signal<string[]>([]);
  protected readonly maxPhotos = MAX_PHOTOS;
  protected readonly submitted = signal(false);
  protected readonly posting = signal(false);
  /** Error not tied to one field (network, 500, ...). */
  protected readonly formError = signal('');

  /** Form value as a signal, so the preview can be a plain computed(). */
  private readonly value = toSignal(this.form.valueChanges, {
    initialValue: this.form.getRawValue(),
  });
  private readonly status = toSignal(this.form.statusChanges, { initialValue: this.form.status });
  protected readonly canPost = computed(() => this.status() === 'VALID' && !this.posting());

  protected readonly preview = computed<Item>(() => {
    const v = { ...this.form.getRawValue(), ...this.value() };
    return {
      no: this.itemsStore.nextNo(),
      title: v.title?.trim() ?? '',
      category: (v.category || 'Other') as Category,
      place: (v.place || 'Main building') as Place,
      placeDetail: v.placeDetail?.trim() || undefined,
      held: v.held ?? 'With finder',
      foundAt: new Date().toISOString(),
      description: v.description ?? '',
      photos: this.photos(),
      photoCaption: 'photo',
      finderId: this.auth.currentUser()?.id ?? '',
      status: 'open',
    };
  });

  /** "3 saved searches match. They'll be notified." Live as you type. */
  protected readonly matchCount = computed(() => {
    const v = this.value();
    if (!v.category || !v.place) return 0;
    return this.itemsStore.countMatchingSearches(this.preview());
  });

  protected pickCategory(category: Category): void {
    this.form.controls.category.setValue(category);
  }

  protected async addPhotos(input: HTMLInputElement): Promise<void> {
    const files = Array.from(input.files ?? []).slice(0, MAX_PHOTOS - this.photos().length);
    input.value = '';
    const urls = await Promise.all(files.map((f) => resizeImage(f)));
    this.photos.update((current) => [...current, ...urls].slice(0, MAX_PHOTOS));
  }

  protected removePhoto(index: number): void {
    this.photos.update((current) => current.filter((_, i) => i !== index));
  }

  protected showError(name: 'title' | 'category' | 'foundAt' | 'place'): boolean {
    const control = this.form.controls[name];
    return control.invalid && (control.touched || this.submitted());
  }

  /** Message the API sent for this field (400 ValidationProblem), if any. */
  protected serverError(name: 'title' | 'category' | 'foundAt' | 'place' | 'description'): string {
    const errors = this.form.controls[name].errors;
    return typeof errors?.['server'] === 'string' ? errors['server'] : '';
  }

  protected async submit(): Promise<void> {
    this.submitted.set(true);
    this.formError.set('');
    if (this.form.invalid || this.posting()) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.getRawValue();
    this.posting.set(true);
    try {
      const item = await this.itemsStore.post({
        title: v.title.trim(),
        category: v.category as Category,
        place: v.place as Place,
        placeDetail: v.placeDetail.trim() || undefined,
        held: v.held,
        foundAt: new Date(v.foundAt).toISOString(),
        description: v.description.trim(),
        photos: this.photos(),
      });
      // The item is saved. If the page can't open (e.g. the site was just updated
      // and old files are gone), load it fresh instead of showing "could not post".
      const opened = await this.router.navigate(['/item', item.no]).catch(() => false);
      if (!opened) window.location.assign(`/item/${item.no}`);
    } catch (error) {
      this.showServerErrors(error);
    } finally {
      this.posting.set(false);
    }
  }

  /** Put the API's validation messages next to the matching fields. */
  private showServerErrors(error: unknown): void {
    if (!(error instanceof ApiError)) {
      this.formError.set('Could not post the item. Please try again.');
      return;
    }
    let placed = false;
    for (const [apiField, messages] of Object.entries(error.fieldErrors)) {
      const name = FORM_FIELD_FROM_API[apiField.replace(/^\$\./, '').toLowerCase()];
      const control = name ? this.form.controls[name] : undefined;
      if (control && messages.length) {
        control.setErrors({ ...control.errors, server: messages[0] });
        control.markAsTouched();
        placed = true;
      }
    }
    if (!placed) this.formError.set(error.message);
  }

  protected close(): void {
    // Back to Browse, keeping its filters.
    this.router.navigate(['..'], { relativeTo: this.route, queryParamsHandling: 'preserve' });
  }
}
