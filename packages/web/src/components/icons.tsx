/**
 * Icon set.
 *
 * These replace the emoji the UI used to draw with. Emoji cannot take a colour,
 * so an "active" tab could only tint its label while the glyph stayed the same —
 * the selected state read as barely selected. These inherit `currentColor`, so
 * every state (active tab, danger button, muted empty state) tints the whole
 * mark, and they render identically on every platform.
 */

type IconProps = {
  /** Matches the surrounding text size by default; set explicitly in chrome. */
  size?: number;
  className?: string;
};

function svg(path: JSX.Element, { size = 20, className }: IconProps): JSX.Element {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {path}
    </svg>
  );
}

export const IconInbox = (props: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M4 13h4l1.5 3h5L16 13h4" />
      <path d="M5.5 5.5h13l1.5 7.5v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-4z" />
    </>,
    props,
  );

export const IconPlus = (props: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M12 5v14M5 12h14" />
    </>,
    props,
  );

export const IconChart = (props: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </>,
    props,
  );

export const IconGear = (props: IconProps): JSX.Element =>
  svg(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
    </>,
    props,
  );

export const IconArrowLeft = (props: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M19 12H5M12 19l-7-7 7-7" />
    </>,
    props,
  );

export const IconDownload = (props: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
    </>,
    props,
  );

export const IconRefresh = (props: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6" />
    </>,
    props,
  );

export const IconCheck = (props: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M20 6 9 17l-5-5" />
    </>,
    props,
  );

export const IconClose = (props: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M18 6 6 18M6 6l12 12" />
    </>,
    props,
  );

export const IconClock = (props: IconProps): JSX.Element =>
  svg(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>,
    props,
  );

export const IconAlert = (props: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M12 9v4M12 17h.01" />
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    </>,
    props,
  );

export const IconLink = (props: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3A5 5 0 0 0 13.5 3.5L11.8 5.2" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3A5 5 0 0 0 10.5 20.5l1.7-1.7" />
    </>,
    props,
  );

export const IconCalendar = (props: IconProps): JSX.Element =>
  svg(
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>,
    props,
  );

export const IconFile = (props: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </>,
    props,
  );

export const IconExternal = (props: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </>,
    props,
  );

export const IconSparkle = (props: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
      <path d="M12 8.5 13.4 11 16 12l-2.6 1-1.4 2.5L10.6 13 8 12l2.6-1z" />
    </>,
    props,
  );
