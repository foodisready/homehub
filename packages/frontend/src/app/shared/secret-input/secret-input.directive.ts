import { Directive, ElementRef, HostListener, inject } from '@angular/core';

/** How wide the eye at the right of the box is, in pixels, for taps. */
const EYE_PX = 40;

/**
 * A password for another service, in a masked text box (see input.secret in
 * styles.css). Tapping the eye at its right shows or hides what's typed. The
 * box isn't wrapped or moved, so it keeps its place in any layout.
 */
@Directive({
  selector: 'input.secret',
  standalone: true,
  host: { title: 'Tap the eye to show or hide the password' },
})
export class SecretInputDirective {
  private readonly el = inject(ElementRef<HTMLInputElement>).nativeElement as HTMLInputElement;

  private onEye(event: MouseEvent): boolean {
    return event.offsetX >= this.el.clientWidth - EYE_PX;
  }

  @HostListener('click', ['$event'])
  toggle(event: MouseEvent): void {
    if (!this.onEye(event)) return;
    this.el.classList.toggle('shown');
    this.el.setAttribute('aria-label', this.el.classList.contains('shown') ? 'Password, shown' : 'Password, hidden');
  }

  @HostListener('mousemove', ['$event'])
  cursor(event: MouseEvent): void {
    this.el.style.cursor = this.onEye(event) ? 'pointer' : '';
  }

  /** Hidden again when the box is left, so a shown password doesn't stay on screen. */
  @HostListener('blur')
  hide(): void {
    this.el.classList.remove('shown');
  }
}
