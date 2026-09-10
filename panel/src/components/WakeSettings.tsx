import { useState } from 'preact/hooks';
import { DEFAULT_WAKE_SENSITIVITY, readWakeSensitivity, saveWakeSensitivity } from '~/assist/native.ts';
import { Icon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { showToast } from '~/state/ui.ts';

export function WakeSettings() {
  const [saved, setSaved] = useState(readWakeSensitivity);
  const [value, setValue] = useState(saved);
  if (saved === null || value === null) return null;

  const save = (next: number): void => {
    try {
      const applied = saveWakeSensitivity(next);
      setSaved(applied);
      setValue(applied);
    } catch {
      setValue(saved);
      showToast('Wake word sensitivity could not be saved', 'error');
    }
  };

  return (
    <section class="wake-settings" aria-label="Wake word">
      <div class="section-head"><h2 class="section-title">Wake word</h2></div>
      <div class="wake-settings-head">
        <label for="wake-sensitivity">Sensitivity</label>
        <output class="tnum" for="wake-sensitivity">{value}%</output>
        <span title="Reset sensitivity to 85%">
          <Pressable class="sheet-close p-sm" ariaLabel="Reset wake word sensitivity" onPress={() => save(DEFAULT_WAKE_SENSITIVITY)}>
            <Icon name="refresh" size="1.2rem" />
          </Pressable>
        </span>
      </div>
      <input id="wake-sensitivity" class="wake-sensitivity" type="range" min="1" max="99" step="1"
        value={value} onInput={(e) => setValue(Number(e.currentTarget.value))}
        onChange={(e) => save(Number(e.currentTarget.value))} />
      <div class="wake-settings-scale"><span>Less sensitive</span><span>More sensitive</span></div>
    </section>
  );
}
