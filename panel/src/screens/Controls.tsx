import { controlPages, controlsConfig } from '~/config/index.ts';
import { Empty } from '~/components/Empty.tsx';
import { Icon, hasIcon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { Slider } from '~/components/Slider.tsx';
import { controlPage, kiosk, markActivity, openSources } from '~/state/ui.ts';
import { entity } from '~/state/entities.ts';
import { keyLightFor, liveLabelOf, pressed, roomosStateOf } from '~/state/controls.ts';
import { pressControl, setKeyLight, setRoomosVolume } from '~/net/socket.ts';
import { KEY_LIGHT_MAX_KELVIN, KEY_LIGHT_MIN_KELVIN } from '@shared/protocol.ts';
import { DeviceTile } from '~/components/DeviceTile.tsx';
import type {
  ControlButton,
  ControlDevice,
  ControlLight,
  ControlPage,
  ControlSources,
  ControlVolume,
} from '@shared/config.ts';
import type { KeyLightState } from '@shared/protocol.ts';

/**
 * Controls — the macro pages.
 *
 * This is the RoomOS macro's UI Extension panels, rebuilt as a web page: the
 * Desk Pro call controls, the office lights, the Apple TV and the rest, each
 * tap going straight to the device it drives — the Desk Pro's xAPI, the
 * television, an Apple TV, a Mac over SSH, Home Assistant or an Elgato Key
 * Light — through the backend, which is the only thing that knows their
 * addresses.
 *
 * Two things it deliberately does NOT do:
 *
 * **It does not pretend a macro button has state.** An xCommand, an SSH
 * command and a webhook are one-way; there is no feedback to read back and no way to know
 * whether the thing at the far end happened. So a button confirms that the
 * request went, and nothing more. A toggle that shows "muted" when it only
 * knows it *asked* for mute is worse than a button.
 *
 * **It does not read the Room Bar.** RoomOS does inject a bound `xapi` object
 * in Persistent Web App mode, but the supported surface is small — bookings,
 * LED control, room analytics, system identity (docs/ROOMOS.md §8) — and does
 * not include call state, mic mute or driving a paired codec. Getting those
 * needs a device-side macro or an authenticated jsxapi socket, which is the
 * thing this screen exists to not need.
 */
export function Controls() {
  const pages = controlPages.value;

  if (pages.length === 0) {
    return (
      <div class="screen screen-enter">
        <div class="screen-head">
          <h1 class="screen-title">Controls</h1>
          {/* Here too. A panel locked while the config had pages, and then
              edited down to none, would otherwise have no control on screen
              that could unlock it. */}
          <FullScreenLock />
        </div>
        <div class="screen-body scroll">
          <Empty icon="grid" title="No control pages configured">
            Add a <code>controls:</code> section to <code>config/dashboard.yaml</code>.
            A page is a list of buttons, each one a command to a Cisco device, a
            TV, an Apple TV or a Mac, a Home Assistant scene or webhook, or an
            Elgato Key Light.
          </Empty>
        </div>
      </div>
    );
  }

  // A page that has been deleted from the config leaves the signal pointing at
  // nothing; fall back to the first rather than showing an empty screen.
  const active = pages.find((p) => p.id === controlPage.value) ?? pages[0]!;

  return (
    <div class="screen screen-enter">
      <div class="screen-head">
        <h1 class="screen-title">Controls</h1>
        <span class="screen-sub truncate">{active.name}</span>
        <FullScreenLock />
      </div>

      {/* A page strip, not a nav level: the Controls screen is one
          destination and these are what is on it. One page is not a choice,
          so it gets no strip — the subtitle already names it.

          The kiosk lock hides it too. "Locked to this page" has to mean this
          page: hiding the nav bar but leaving the strip would still let
          anyone wander off to Lights, which is most of what the lock is for. */}
      {pages.length > 1 && !kiosk.value ? <PageTabs pages={pages} active={active.id} /> : null}

      <div class="screen-body scroll">
        <Page page={active} />
      </div>
    </div>
  );
}

/**
 * Lock the panel to the page it is on.
 *
 * In the screen head rather than in a device tile, which is where it used to
 * be. There it only existed on a page that happened to declare a `device:`
 * item, so a page of lights or a room page could not be locked at all — and
 * a panel locked from the one page that had the button had no way back from
 * any other.
 *
 * **Always rendered, in both states.** Locking hides the nav and the page
 * strip, so this is the only control left that can undo it. A version of
 * this that could itself be conditional would be a panel on a wall with no
 * way out of the mode it is in. That is also why it sits in the head and not
 * in the scrolling body: it must not be possible to scroll the way out off
 * the screen.
 */
function FullScreenLock() {
  const locked = kiosk.value;
  return (
    <Pressable
      class="screen-lock"
      onPress={() => {
        kiosk.value = !locked;
        markActivity();
      }}
      ariaLabel={locked ? 'Leave full screen' : 'Full screen, locked to this page'}
      ariaPressed={locked}
    >
      <Icon name={locked ? 'collapse' : 'expand'} size="1.375rem" weight={1.9} />
    </Pressable>
  );
}

function PageTabs({ pages, active }: { pages: ControlPage[]; active: string }) {
  return (
    <div class="control-tabs">
      {pages.map((page) => (
        <Pressable
          key={page.id}
          class={page.id === active ? 'control-tab is-active' : 'control-tab'}
          onPress={() => {
            controlPage.value = page.id;
            markActivity();
          }}
          ariaLabel={page.name}
          ariaPressed={page.id === active}
        >
          <Icon name={hasIcon(page.icon) ? page.icon : 'grid'} size="1.25rem" weight={1.7} />
          <span class="truncate">{page.name}</span>
        </Pressable>
      ))}
    </div>
  );
}

function Page({ page }: { page: ControlPage }) {
  if (page.items.length === 0) {
    return (
      <Empty icon="grid" title={`${page.name} has no buttons`}>
        Add an <code>items:</code> list to this page in{' '}
        <code>config/dashboard.yaml</code>.
      </Empty>
    );
  }

  /*
   * Buttons and key lights are laid out separately, in that order, however
   * they are interleaved in the config.
   *
   * They are different shapes — a button is a square tap target, a light is a
   * wide card with two sliders — and mixing them in one grid gives every row
   * the height of the tallest thing in it. Grouping is what keeps a page of
   * six buttons and one light from looking like a form.
   */
  // Source pickers sit in the key grid: they look like keys and are pressed
  // like keys. Only what happens next differs.
  // Volume controls sit in the grid too, filling the rest of their row — so
  // a card beside the last key uses the space instead of leaving a gap and
  // adding another block below.
  const keys = page.items.filter((i): i is ControlButton | ControlSources | ControlVolume =>
    i.type === 'button' || i.type === 'sources' || i.type === 'volume',
  );
  const spans = volumeSpans(keys, page.columns);
  const lights = page.items.filter(isLight);
  const devices = page.items.filter((i): i is ControlDevice => i.type === 'device');

  return (
    <>
      {/* Device tiles come FIRST and take the height they need. A tile is the
          page's subject when there is one — a Desk Pro with its meetings and
          its live mute state is not a peer of a key that fires and forgets. */}
      {devices.map((item) => (
        <DeviceTile
          key={item.id}
          item={item}
          compact={keys.length > 0 || lights.length > 0}
        />
      ))}

      {keys.length > 0 ? (
        <div
          class="macro-grid"
          data-size={page.size === 'lg' ? 'lg' : undefined}
          /*
           * The column count is set inline rather than through a CSS custom
           * property, because `repeat()` needs a literal integer and pushing
           * a variable into it is the kind of thing that works until it
           * quietly does not on Chromium 102.
           */
          /* The count, not the tracks: the grid in screens.css turns it into
             "at most this many, fewer when they would be too narrow". Writing
             the tracks here instead pinned four columns at every width, and
             an inline style is the one thing a media query cannot answer. */
          style={page.columns > 0 ? { '--cols': String(page.columns) } : undefined}
        >
          {keys.map((item) =>
            item.type === 'sources' ? (
              <SourcesButton key={item.id} item={item} />
            ) : item.type === 'volume' ? (
              <VolumeCard
                key={item.id}
                item={item}
                span={spans.get(item.id) ?? 0}
                large={page.size === 'lg'}
              />
            ) : (
              <MacroButton key={item.id} button={item} />
            ),
          )}
        </div>
      ) : null}

      {lights.map((item) => (
        <KeyLightCard key={item.id} item={item} />
      ))}
    </>
  );
}

function MacroButton({ button }: { button: ControlButton }) {
  const confirming = pressed.value.has(button.id);
  const live = liveLabelOf(button);
  // The input belongs in the accessible name too: the visible label is a
  // second line under the key, and a screen reader that only ever hears
  // "LG Input" is missing the half that changes.
  const ariaLabel = live ? `${button.name}, ${live.text}` : button.name;

  return (
    <Pressable
      // `wide: true` spans two columns, for the one action on a page that is
      // not a peer of the others — Join, on a page whose other buttons only
      // make sense during a call.
      class={button.wide ? 'macro-btn is-wide p-lg' : 'macro-btn p-lg'}
      onPress={() => {
        pressControl(button.id);
        markActivity();
      }}
      ariaLabel={ariaLabel}
    >
      {/* The tone drives colour and the confirmation is a separate
          attribute, so a danger button flashing its tick does not stop
          looking like a danger button. */}
      <span class="macro-btn-face" data-tone={button.tone} data-confirm={confirming ? '' : undefined}>
        <Icon
          name={hasIcon(button.icon) ? button.icon : 'grid'}
          size="1.75rem"
          weight={1.6}
          class="macro-btn-icon"
        />
        <Icon name="check" size="1.75rem" weight={2.2} class="macro-btn-tick" />
      </span>
      <span class="macro-btn-name truncate">{button.name}</span>
      {/* What the television is actually on, under the key's own name. Only
          for a key that steps through inputs: everywhere else the panel has
          nothing to report and a second line would be decoration.

          `data-assumed` marks the weaker claim — the input this panel last
          selected, on a set that will not say what it is showing. It reads
          the same, quieter, because it is usually right and is worth showing;
          it is marked because it can be wrong and the panel should not
          pretend otherwise. */}
      {live !== null ? (
        <span class="macro-btn-sub truncate" data-assumed={live.assumed ? '' : undefined}>
          {live.text}
        </span>
      ) : null}
    </Pressable>
  );
}

/**
 * A key light: power, brightness, colour temperature.
 *
 * The one control on this screen with real state, so it is the one that
 * behaves like a dashboard tile rather than a button. `all` is a single
 * control over every configured light — the backend fans it out, so two
 * lights either side of a desk cannot end up disagreeing because one command
 * of a pair failed.
 */
function KeyLightCard({ item }: { item: ControlLight }) {
  const light = keyLightFor(item.light);

  if (!light) {
    return (
      <div class="card keylight">
        <div class="keylight-head">
          <div class="keylight-name truncate">{item.name}</div>
          <div class="keylight-state">Not configured</div>
        </div>
      </div>
    );
  }

  const off = !light.on;

  return (
    <div class="card keylight" data-off={off ? '' : undefined}>
      <div class="keylight-head">
        <Pressable
          class="keylight-power"
          onPress={() => {
            setKeyLight(item.light, 'toggle');
            markActivity();
          }}
          ariaLabel={`${item.name}: turn ${off ? 'on' : 'off'}`}
          ariaPressed={light.on}
          disabled={!light.reachable}
        >
          <Icon name="power" size="1.5rem" weight={1.9} />
        </Pressable>

        <div class="keylight-titles">
          <div class="keylight-name truncate">{item.name}</div>
          <div class="keylight-state">{describe(light)}</div>
        </div>
      </div>

      <Slider
        value={light.brightness}
        min={0}
        max={100}
        size="lg"
        class="slider-warm"
        disabled={!light.reachable}
        readout={`${light.brightness}%`}
        ariaLabel={`${item.name} brightness`}
        icon={<Icon name="bulb" size="1.125rem" />}
        onChange={(value, final) => {
          // Only the release is sent. Unlike a Home Assistant light, this is
          // an HTTP round trip per command to a device with no queue — a
          // continuous stream of them during a drag would arrive out of order
          // and leave the light wherever the losing packet said.
          if (final) {
            setKeyLight(item.light, 'brightness', value);
            markActivity();
          }
        }}
      />

      <Slider
        value={light.temperature}
        min={KEY_LIGHT_MIN_KELVIN}
        max={KEY_LIGHT_MAX_KELVIN}
        step={50}
        class="slider-temp"
        disabled={!light.reachable}
        readout={`${light.temperature}K`}
        ariaLabel={`${item.name} colour temperature`}
        icon={<Icon name="sun" size="1.125rem" />}
        onChange={(value, final) => {
          if (final) {
            setKeyLight(item.light, 'temperature', value);
            markActivity();
          }
        }}
      />
    </div>
  );
}

/**
 * A key that opens the input picker.
 *
 * Deliberately NOT a confirmation-tick key: opening a menu is its own
 * feedback, and a tick would claim a request went somewhere when nothing has
 * been sent yet.
 */
function SourcesButton({ item }: { item: ControlSources }) {
  const state = entity(item.entity).value;
  const unavailable = !state || state.s === 'unavailable';

  return (
    <Pressable
      class="macro-btn p-lg"
      onPress={() => {
        openSources.value = item.id;
        markActivity();
      }}
      ariaLabel={`${item.name}: choose input`}
      disabled={unavailable}
    >
      <span class="macro-btn-face">
        <Icon
          name={hasIcon(item.icon) ? item.icon : 'input'}
          size="1.75rem"
          weight={1.6}
          class="macro-btn-icon"
        />
      </span>
      {/* The key keeps its configured name. Showing the current input here
          instead was tried and is worse: the label stops saying what the key
          IS, and it changes identity when the TV reports nothing. The live
          value belongs in the sheet, which has room for it. */}
      <span class="macro-btn-name truncate">{item.name}</span>
    </Pressable>
  );
}

/**
 * A RoomOS device's volume: a mute key and a level slider, both read back
 * from the device.
 *
 * Laid out like a key light card on purpose — it is the same kind of thing,
 * a control with live state — with the device's own mute where the light's
 * power key is. The level is sent on release only: every step of a drag is
 * an xCommand to a codec, and a stream of them would arrive out of order and
 * leave the volume wherever the losing one said.
 */
/**
 * How many columns each volume card spans: the rest of the row it starts in,
 * or the whole row when it starts one. 0 means the whole row regardless —
 * the page has no fixed column count, so where a row ends is not known.
 */
function volumeSpans(
  keys: (ControlButton | ControlSources | ControlVolume)[],
  columns: number,
): Map<string, number> {
  const spans = new Map<string, number>();
  let at = 0;
  for (const item of keys) {
    if (item.type === 'volume') {
      if (columns <= 0) {
        spans.set(item.id, 0);
        continue;
      }
      const span = columns - (at % columns);
      spans.set(item.id, span);
      at += span;
      continue;
    }
    const width = item.type === 'button' && item.wide ? 2 : 1;
    // A wide key that would not fit wraps, and so does the count.
    if (columns > 0 && width > 1 && (at % columns) + width > columns) at += columns - (at % columns);
    at += width;
  }
  return spans;
}

function VolumeCard({ item, span, large }: { item: ControlVolume; span: number; large: boolean }) {
  const state = roomosStateOf(item.device);
  const reachable = Boolean(state?.reachable) && state?.volume !== null;
  const level = state?.volume ?? 0;
  const muted = state?.muted === true;

  return (
    <div
      class="card keylight is-volume macro-volume"
      data-off={muted || !reachable ? '' : undefined}
      style={{ gridColumn: span > 0 ? `span ${span}` : '1 / -1' }}
    >
      <div class="keylight-head">
        <Pressable
          class="keylight-power"
          onPress={() => {
            setRoomosVolume(item.id, muted ? 'unmute' : 'mute');
            markActivity();
          }}
          ariaLabel={`${item.name}: ${muted ? 'unmute' : 'mute'}`}
          ariaPressed={muted}
          disabled={!reachable}
        >
          <Icon name={muted ? 'mute' : 'volume'} size="1.5rem" weight={1.9} />
        </Pressable>

        <div class="keylight-titles">
          <div class="keylight-name truncate">{item.name}</div>
          <div class="keylight-state">
            {!reachable ? 'Unreachable' : muted ? `Muted · ${level}` : `${level}`}
          </div>
        </div>
      </div>

      <Slider
        value={level}
        min={0}
        max={100}
        size={large ? 'lg' : undefined}
        disabled={!reachable}
        readout={String(level)}
        ariaLabel={`${item.name} volume`}
        icon={<Icon name="volume" size="1.125rem" />}
        onChange={(value, final) => {
          if (final) {
            setRoomosVolume(item.id, 'level', value);
            markActivity();
          }
        }}
      />
    </div>
  );
}

function describe(light: KeyLightState): string {
  if (!light.reachable) return 'Unreachable';
  if (!light.on) return 'Off';
  return `${light.brightness}% · ${light.temperature}K`;
}

function isLight(item: ControlPage['items'][number]): item is ControlLight {
  return item.type === 'light';
}
