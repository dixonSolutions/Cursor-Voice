import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** App logo mark — uses the PWA icon from /public. */
@Component({
  selector: 'cv-brand-logo',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <img
      class="cv-brand-logo"
      [class.cv-brand-logo--sm]="size() === 'sm'"
      [class.cv-brand-logo--md]="size() === 'md'"
      [class.cv-brand-logo--lg]="size() === 'lg'"
      src="/icon.svg"
      [attr.width]="dimension()"
      [attr.height]="dimension()"
      alt=""
      aria-hidden="true" />
  `,
  styles: `
    :host {
      display: inline-flex;
      flex-shrink: 0;
    }

    .cv-brand-logo {
      display: block;
      border-radius: 0.45rem;
      object-fit: contain;
    }

    .cv-brand-logo--sm {
      width: 1.75rem;
      height: 1.75rem;
      border-radius: 0.4rem;
    }

    .cv-brand-logo--md {
      width: 2rem;
      height: 2rem;
    }

    .cv-brand-logo--lg {
      width: 3rem;
      height: 3rem;
      border-radius: 0.65rem;
    }
  `,
})
export class BrandLogoComponent {
  readonly size = input<'sm' | 'md' | 'lg'>('md');

  protected dimension(): number {
    switch (this.size()) {
      case 'sm':
        return 28;
      case 'lg':
        return 48;
      default:
        return 32;
    }
  }
}
