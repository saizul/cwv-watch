import { escapeHtml } from './escape.js';

export interface SparklineOptions {
  width?: number;
  height?: number;
  /** Draw dashed reference lines at these values when inside the plotted range (e.g. rating boundaries). */
  references?: Array<{ value: number; className: string }>;
  title?: string;
  /** Format for the tooltip of the last point. */
  format?: (value: number) => string;
}

const BLOCKS = '▁▂▃▄▅▆▇█';

/** Text sparkline for Markdown and terminals; gaps (null) render as a space. */
export function textSparkline(values: Array<number | null>): string {
  const present = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (present.length === 0) return '';
  const min = Math.min(...present);
  const max = Math.max(...present);
  return values
    .map((v) => {
      if (v === null || !Number.isFinite(v)) return ' ';
      if (max === min) return BLOCKS[3];
      return BLOCKS[Math.round(((v - min) / (max - min)) * (BLOCKS.length - 1))];
    })
    .join('');
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Inline SVG sparkline. Null values split the line into segments so missing
 * CrUX periods are visible as gaps instead of being interpolated.
 */
export function svgSparkline(values: Array<number | null>, options: SparklineOptions = {}): string {
  const width = options.width ?? 120;
  const height = options.height ?? 28;
  const pad = 3;
  const present = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const title = options.title ? `<title>${escapeHtml(options.title)}</title>` : '';
  const open = `<svg class="spark" xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">${title}`;
  if (present.length === 0) {
    return `${open}<text x="${width / 2}" y="${height / 2 + 4}" text-anchor="middle" class="spark-empty">no data</text></svg>`;
  }
  let min = Math.min(...present);
  let max = Math.max(...present);
  if (max === min) {
    const bump = max === 0 ? 1 : Math.abs(max) * 0.1;
    min -= bump;
    max += bump;
  }
  const n = values.length;
  const x = (i: number) => (n === 1 ? width / 2 : pad + (i * (width - 2 * pad)) / (n - 1));
  const y = (v: number) => height - pad - ((v - min) / (max - min)) * (height - 2 * pad);

  const parts: string[] = [];
  for (const ref of options.references ?? []) {
    if (ref.value > min && ref.value < max) {
      const ry = round(y(ref.value));
      parts.push(`<line class="${escapeHtml(ref.className)}" x1="0" x2="${width}" y1="${ry}" y2="${ry}"/>`);
    }
  }
  let segment: string[] = [];
  const flush = () => {
    if (segment.length > 1) parts.push(`<polyline class="spark-line" fill="none" points="${segment.join(' ')}"/>`);
    else if (segment.length === 1) {
      const [px, py] = segment[0]!.split(',');
      parts.push(`<circle class="spark-dot" cx="${px}" cy="${py}" r="1.5"/>`);
    }
    segment = [];
  };
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) flush();
    else segment.push(`${round(x(i))},${round(y(v))}`);
  });
  flush();
  let lastIndex = -1;
  values.forEach((v, i) => {
    if (v !== null && Number.isFinite(v)) lastIndex = i;
  });
  const last = values[lastIndex]!;
  const label = options.format ? options.format(last) : String(last);
  parts.push(
    `<circle class="spark-last" cx="${round(x(lastIndex))}" cy="${round(y(last))}" r="2.5"><title>${escapeHtml(label)}</title></circle>`,
  );
  return `${open}${parts.join('')}</svg>`;
}
