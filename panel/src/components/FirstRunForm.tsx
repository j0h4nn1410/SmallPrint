import { useState } from "preact/hooks";
import { saveSettings } from "../storage";
import type { Settings } from "../types";
import { DEFAULT_SETTINGS } from "../types";

interface Props {
  onComplete: (settings: Settings) => void;
  /** Settings to start from. Pass the saved settings when the form is reopened from Settings. */
  initial?: Settings;
  title?: string;
}

const RECORD_KIND_OPTIONS = [
  { id: "donation", label: "Political donations" },
  { id: "gender_pay_gap", label: "Gender pay gap" },
  { id: "modern_slavery", label: "Modern slavery statements" },
  { id: "asa_ruling", label: "ASA advertising rulings" },
  { id: "climate", label: "Climate targets" },
  { id: "news", label: "In the news (BBC, Reuters, Guardian and others)" },
];

export function FirstRunForm({ onComplete, initial = DEFAULT_SETTINGS, title = "Set up Small Print" }: Props) {
  const [horizon, setHorizon] = useState<12 | 24>(initial.horizon);
  const [recordKinds, setRecordKinds] = useState<string[]>(initial.recordKinds);

  function toggleKind(id: string) {
    setRecordKinds((prev) =>
      prev.includes(id) ? prev.filter((k) => k !== id) : [...prev, id]
    );
  }

  async function handleSkip() {
    const settings: Settings = { ...DEFAULT_SETTINGS };
    await saveSettings(settings);
    onComplete(settings);
  }

  async function handleSave(e: Event) {
    e.preventDefault();
    const settings: Settings = { horizon, recordKinds };
    await saveSettings(settings);
    onComplete(settings);
  }

  return (
    <div class="first-run">
      <h1 class="first-run__title">{title}</h1>
      <p class="first-run__subtitle">Takes 30 seconds. You can change this any time.</p>

      <form onSubmit={handleSave} class="first-run__form">
        <fieldset>
          <legend>Default horizon for cost calculations</legend>
          <div class="toggle-group">
            <button type="button" class={horizon === 12 ? "toggle active" : "toggle"} onClick={() => setHorizon(12)}>12 months</button>
            <button type="button" class={horizon === 24 ? "toggle active" : "toggle"} onClick={() => setHorizon(24)}>24 months</button>
          </div>
        </fieldset>

        <fieldset>
          <legend>Flag company records for</legend>
          <div class="checkbox-group">
            {RECORD_KIND_OPTIONS.map((opt) => (
              <label key={opt.id} class="checkbox-label">
                <input
                  type="checkbox"
                  checked={recordKinds.includes(opt.id)}
                  onChange={() => toggleKind(opt.id)}
                />
                {opt.label}
              </label>
            ))}
          </div>
        </fieldset>

        <div class="first-run__actions">
          <button type="submit" class="btn btn--primary">Save and start</button>
          <button type="button" class="btn btn--ghost" onClick={handleSkip}>Skip (use defaults)</button>
        </div>
      </form>
    </div>
  );
}
