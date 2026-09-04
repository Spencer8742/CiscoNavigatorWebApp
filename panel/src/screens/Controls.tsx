import { controlPages } from '~/config/index.ts';
import { Empty } from '~/components/Empty.tsx';
import { Icon, hasIcon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { Slider } from '~/components/Slider.tsx';
import { controlPage, kiosk, markActivity, openSources, openTvInput } from '~/state/ui.ts';
import { entity } from '~/state/entities.ts';
import { keyLightFor, pressed } from '~/state/controls.ts';
import { pressControl, setKeyLight } from '~/net/socket.ts';
import { KEY_LIGHT_MAX_KELVIN, KEY_LIGHT_MIN_KELVIN } from '@shared/protocol.ts';
import { DeviceTile } from '~/components/DeviceTile.tsx';
import type {
  ControlButton,
  ControlDevice,
  ControlLight,
  ControlPage,
  ControlSources,
  ControlTv,
  ControlTvInput,
} from '@shared/config.ts';
import type { KeyLightState } from '@shared/protocol.ts';

/**
 * Controls — the macro pages.
 *
 * This is the RoomOS macro's UI Extension panels, rebuilt as a web page: the
 * Desk Pro call controls, the office lights, the Apple TV and the rest, each
 * tap going to Bitfocus Companion, a Home Assistant webhook, or an Elgato Key
 * Light — through the backend, which is the only thing that knows their
 * addresses.
 *
 * Two things it deliberately does NOT do:
 *
 * **It does not pretend a macro button has state.** A Companion press and a
 * webhook are one-way; there is no feedback to read back and no way to know
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
        </div>
        <div class="screen-body scroll">
          <Empty icon="grid" title="No control pages configured">
            Add a <code>controls:</code> section to <code>config/dashboard.yaml</code>.
            A page is a list of buttons, each one a Companion location, a Home
            Assistant webhook, a scene, or an Elgato Key Light.
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
  const keys = page.items.filter(
    (i): i is ControlButton | ControlSources | ControlTv | ControlTvInput =>
      i.type === 'button' ||
      i.type === 'sources' ||
      // A TV key is pressed like a key and looks like one. Only where the
      // press goes differs — straight to the television rather than through
      // Home Assistant.
      i.type === 'tv' ||
      i.type === 'tvInput',
  );
  const lights = page.items.filter(isLight);
  const devices = page.items.filter((i): i is ControlDevice => i.type === 'device');

  return (
    <>
      {/* Device tiles come FIRST and take the height they need. A tile is the
          page's subject when there is one — a Desk Pro with its meetings and
          its live mute state is not a peer of a key that fires and forgets. */}
      {devices.map((item) => (
        <DeviceTile key={item.id} item={item} compact={keys.length > 0 || lights.length > 0} />
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
          style={page.columns > 0 ? { gridTemplateColumns: `repeat(${page.columns}, 1fr)` } : undefined}
        >
          {keys.map((item) =>
            item.type === 'sources' ? (
              <SourcesButton key={item.id} item={item} />
            ) : item.type === 'tvInput' ? (
              <TvInputButton key={item.id} item={item} />
            ) : item.type === 'tv' ? (
              <TvPowerButton key={item.id} item={item} />
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
      ariaLabel={button.name}
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
 * A key that powers a television directly.
 *
 * Keeps the confirmation tick of any other macro key rather than showing
 * on/off state. The backend CAN tell whether the set is reachable, but only
 * by opening a connection to it — so a lit key here would mean polling a
 * television every few seconds to keep a light accurate, which is a lot of
 * knocking on a device that is trying to be asleep.
 */
function TvPowerButton({ item }: { item: ControlTv }) {
  const confirming = pressed.value.has(item.id);

  return (
    <Pressable
      class="macro-btn p-lg"
      onPress={() => {
        pressControl(item.id);
        markActivity();
      }}
      ariaLabel={item.name}
    >
      <span class="macro-btn-face" data-confirm={confirming ? '' : undefined}>
        <Icon
          name={hasIcon(item.icon) ? item.icon : 'tv'}
          size="1.75rem"
          weight={1.6}
          class="macro-btn-icon"
        />
        <Icon name="check" size="1.75rem" weight={2.2} class="macro-btn-tick" />
      </span>
      <span class="macro-btn-name truncate">{item.name}</span>
    </Pressable>
  );
}

/** A key that opens the input picker for a directly-driven television. */
function TvInputButton({ item }: { item: ControlTvInput }) {
  return (
    <Pressable
      class="macro-btn p-lg"
      onPress={() => {
        openTvInput.value = item.id;
        markActivity();
      }}
      ariaLabel={`${item.name}: choose input`}
    >
      {/* No confirmation tick: opening a menu is its own feedback, and a tick
          would claim a press went somewhere when nothing has been sent. */}
      <span class="macro-btn-face">
        <Icon
          name={hasIcon(item.icon) ? item.icon : 'input'}
          size="1.75rem"
          weight={1.6}
          class="macro-btn-icon"
        />
      </span>
      <span class="macro-btn-name truncate">{item.name}</span>
    </Pressable>
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
