import { Component, type ComponentChildren } from 'preact';
import { Icon } from '~/components/Icon.tsx';

/**
 * The last line of defence.
 *
 * On a Room Navigator in Persistent Web App mode there is no address bar, no
 * back button, no reload, and the app "can't be dismissed by users"
 * (docs/ROOMOS.md §8). An unhandled render error would leave a blank screen
 * on a wall until somebody fetches a ladder and a laptop.
 *
 * So this boundary does two things a normal web app's would not:
 *
 * 1. It shows a **useful** message rather than a spinner, including the error
 *    text, because the person reading it is standing in front of the panel
 *    trying to work out what happened.
 *
 * 2. It **recovers by itself**. A single render failure is usually transient
 *    (a malformed attribute from an integration, a race during reconnect), so
 *    it retries once after a short delay, and only if that fails too does it
 *    fall back to a full reload. `location.reload()` is safe here: the token
 *    is recoverable from the provisioned URL (see net/auth.ts) and all state
 *    is re-delivered by the backend's `hello`, so a reload costs about a
 *    second and loses nothing.
 */

interface Props {
  children?: ComponentChildren;
}

interface State {
  error: Error | null;
  attempts: number;
}

const RETRY_DELAY_MS = 2500;
const MAX_INLINE_RETRIES = 2;

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, attempts: 0 };
  #timer: ReturnType<typeof setTimeout> | undefined;

  static override getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error): void {
    // Goes to the remote DevTools console (docs/ROOMOS.md §10), which is the
    // only place anyone will ever read it.
    console.error('[panel] render error', error);

    this.#timer = setTimeout(() => {
      if (this.state.attempts < MAX_INLINE_RETRIES) {
        // Retry in place: cheapest possible recovery, no visible interruption
        // beyond the couple of seconds already spent.
        this.setState((s) => ({ error: null, attempts: s.attempts + 1 }));
      } else {
        // Repeated failures mean our in-memory state is probably the problem.
        // Start clean.
        window.location.reload();
      }
    }, RETRY_DELAY_MS);
  }

  override componentWillUnmount(): void {
    clearTimeout(this.#timer);
  }

  override render() {
    if (!this.state.error) return this.props.children;

    return (
      <div class="fatal">
        <Icon name="alert" size="2.5rem" weight={1.5} />
        <h1>Something went wrong</h1>
        <p>
          {this.state.attempts < MAX_INLINE_RETRIES
            ? 'Recovering automatically…'
            : 'Restarting the panel…'}
        </p>
        <p class="fatal-detail">{this.state.error.message}</p>
      </div>
    );
  }
}
