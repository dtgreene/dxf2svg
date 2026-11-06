import './style.css';
import { parseDxf, type Dxf } from './dxf.ts';
import {
  bounds,
  diagonal,
  flatten,
  join,
  merge,
  totalSegments,
  type Flattened,
  type Path,
} from './paths.ts';
import { toSvg } from './svg.ts';

const buttonClass =
  'block w-full cursor-pointer rounded-md bg-accent px-4 py-2.5 text-center font-semibold text-accent-text';
const mutedClass = 'text-sm wrap-anywhere text-muted';
const fieldClass = 'flex items-center gap-2';
const numberClass =
  'min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1.5';
const labelClass = 'text-sm font-semibold';
// "unit" has no styles of its own: it is the hook for filling in the drawing's unit.
const unitClass = 'unit text-sm text-muted';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
<main class="grid h-screen grid-cols-[320px_minmax(0,1fr)] gap-4 p-4 max-[760px]:h-auto max-[760px]:grid-cols-1 max-[760px]:grid-rows-[auto_60vh]">
  <section class="flex flex-col gap-4 overflow-y-auto">
    <header>
      <h1 class="text-2xl font-bold">DXF to SVG</h1>
    </header>

    <label class="${buttonClass} focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent">
      Choose DXF file
      <input id="file" class="absolute size-px opacity-0" type="file" accept=".dxf" />
    </label>
    <p id="error" class="text-sm text-error" role="alert" hidden></p>

    <fieldset id="controls" class="flex flex-col gap-2 disabled:opacity-50" disabled>
      <label class="${labelClass}" for="merge">Merge segments shorter than</label>
      <div class="${fieldClass}">
        <input id="merge" class="${numberClass}" type="number" min="0" step="any" value="0" />
        <span class="${unitClass}"></span>
      </div>
      <input id="merge-range" class="w-full accent-accent" type="range" min="0" max="1" step="0.01" value="0"
        aria-label="Merge segments shorter than" />

      <label class="${labelClass} mt-2" for="join">Join endpoints closer than</label>
      <div class="${fieldClass}">
        <input id="join" class="${numberClass}" type="number" min="0" step="any" value="0" />
        <span class="${unitClass}"></span>
      </div>
    </fieldset>

    <dl id="stats" class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm [&>dd]:wrap-anywhere [&>dd]:tabular-nums [&>dt]:text-muted" hidden></dl>

    <button id="download" class="${buttonClass} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-45" type="button" disabled>Download SVG</button>
  </section>

  <section id="preview" class="grid min-h-0 place-items-center rounded-lg border border-border bg-surface p-4 in-[.dragging]:border-accent in-[.dragging]:outline-2 in-[.dragging]:outline-accent" aria-label="SVG preview">
    <p class="${mutedClass}">Your drawing will appear here.</p>
  </section>
</main>
`;

const element = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const fileInput = element<HTMLInputElement>('file');
const errorBox = element<HTMLParagraphElement>('error');
const controls = element<HTMLFieldSetElement>('controls');
const mergeInput = element<HTMLInputElement>('merge');
const mergeRange = element<HTMLInputElement>('merge-range');
const joinInput = element<HTMLInputElement>('join');
const stats = element<HTMLDListElement>('stats');
const downloadButton = element<HTMLButtonElement>('download');
const preview = element<HTMLElement>('preview');

interface Loaded {
  name: string;
  unit: Dxf['unit'];
  flat: Flattened;
}

let loaded: Loaded | null = null;
let joined: { tolerance: number; paths: Path[] } | null = null;
let svg = '';
let frame = 0;

const readLength = (input: HTMLInputElement) =>
  Math.max(0, Number(input.value) || 0);
const oneFigure = (value: number) => Number(value.toPrecision(1));
const count = (value: number) => value.toLocaleString();

function showError(message: string) {
  errorBox.textContent = message;
  errorBox.hidden = false;
  loaded = null;
  joined = null;
  svg = '';
  controls.disabled = true;
  downloadButton.disabled = true;
  stats.hidden = true;
  preview.replaceChildren();
}

function skippedSummary(skipped: Map<string, number>): string {
  return [...skipped]
    .sort((a, b) => b[1] - a[1])
    .map(([type, total]) => `${count(total)} ${type}`)
    .join(', ');
}

function showStats(rows: [string, string][]) {
  stats.replaceChildren(
    ...rows.flatMap(([term, detail]) => {
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = term;
      dd.textContent = detail;
      return [dt, dd];
    }),
  );
  stats.hidden = false;
}

function update() {
  if (!loaded) return;
  const { flat, unit } = loaded;

  const tolerance = readLength(joinInput);
  if (joined?.tolerance !== tolerance) {
    joined = { tolerance, paths: join(flat.paths, tolerance) };
  }
  const merged = merge(joined.paths, readLength(mergeInput));

  svg = toSvg(merged, unit);
  preview.innerHTML = svg;

  const box = bounds(merged);
  const size = (value: number) => Number(value.toFixed(2)).toLocaleString();
  const rows: [string, string][] = [
    [
      'Segments',
      `${count(totalSegments(flat.paths))} → ${count(totalSegments(merged))}`,
    ],
    ['Paths', `${count(flat.paths.length)} → ${count(merged.length)}`],
    [
      'Size',
      `${size(box.maxX - box.minX)} × ${size(box.maxY - box.minY)} ${unit ?? 'units'}`,
    ],
  ];
  if (flat.skipped.size > 0)
    rows.push(['Not converted', skippedSummary(flat.skipped)]);
  showStats(rows);
}

function scheduleUpdate() {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(update);
}

async function load(file: File) {
  errorBox.hidden = true;
  try {
    const dxf = parseDxf(await file.text());
    const flat = flatten(dxf);
    if (flat.paths.length === 0) {
      const detail =
        flat.skipped.size > 0
          ? ` Found only: ${skippedSummary(flat.skipped)}.`
          : '';
      showError(`No convertible geometry in this file.${detail}`);
      return;
    }

    const size = diagonal(flat.paths);
    const rangeMax = Number((size / 20).toPrecision(2));
    mergeRange.max = String(rangeMax);
    mergeRange.step = String(rangeMax / 500);
    mergeInput.value = String(oneFigure(size / 1000));
    mergeRange.value = mergeInput.value;
    joinInput.value = String(oneFigure(size / 100000));

    const unit = dxf.unit ?? 'units';
    document
      .querySelectorAll('.unit')
      .forEach((label) => (label.textContent = unit));

    loaded = { name: file.name, unit: dxf.unit, flat };
    joined = null;
    controls.disabled = false;
    downloadButton.disabled = false;
    update();
  } catch (error) {
    showError(
      error instanceof Error ? error.message : 'Could not read this file.',
    );
  }
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void load(file);
});

mergeInput.addEventListener('input', () => {
  mergeRange.value = mergeInput.value;
  scheduleUpdate();
});

mergeRange.addEventListener('input', () => {
  mergeInput.value = String(Number(Number(mergeRange.value).toPrecision(3)));
  scheduleUpdate();
});

joinInput.addEventListener('input', scheduleUpdate);

downloadButton.addEventListener('click', () => {
  if (!loaded) return;
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = loaded.name.replace(/\.dxf$/i, '') + '.svg';
  link.click();
  URL.revokeObjectURL(url);
});

window.addEventListener('dragover', (event) => {
  event.preventDefault();
  document.body.classList.add('dragging');
});

window.addEventListener('dragleave', (event) => {
  if (event.relatedTarget === null) document.body.classList.remove('dragging');
});

window.addEventListener('drop', (event) => {
  event.preventDefault();
  document.body.classList.remove('dragging');
  const file = event.dataTransfer?.files[0];
  if (file) void load(file);
});
