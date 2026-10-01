'use strict';

const MINUTE = 60;
const HOUR = MINUTE * 60;
const DAY = HOUR * 24;
const WEEK = DAY * 7;
const MONTH = DAY * 30;
const YEAR = DAY * 365;

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'} ago`;
}

/** "3 days ago" style, deliberately coarse — precision is not the point here. */
function relativeDate(date, now = new Date()) {
  if (!date) return '';
  const seconds = Math.round((now.getTime() - date.getTime()) / 1000);

  if (seconds < 0) return 'just now';
  if (seconds < 10) return 'just now';
  if (seconds < MINUTE) return plural(seconds, 'second');
  if (seconds < HOUR) return plural(Math.floor(seconds / MINUTE), 'minute');
  if (seconds < DAY) return plural(Math.floor(seconds / HOUR), 'hour');
  if (seconds < WEEK) return plural(Math.floor(seconds / DAY), 'day');
  if (seconds < MONTH) return plural(Math.floor(seconds / WEEK), 'week');
  if (seconds < YEAR) return plural(Math.floor(seconds / MONTH), 'month');
  return plural(Math.floor(seconds / YEAR), 'year');
}

/**
 * A short date for places with no room — the history rows, where the author
 * name and date compete for a narrow column.
 */
function compactDate(date, now = new Date()) {
  if (!date) return '';
  const seconds = Math.round((now.getTime() - date.getTime()) / 1000);

  if (seconds < MINUTE) return 'now';
  if (seconds < HOUR) return `${Math.floor(seconds / MINUTE)}m`;
  if (seconds < DAY) return `${Math.floor(seconds / HOUR)}h`;
  if (seconds < WEEK) return `${Math.floor(seconds / DAY)}d`;
  if (seconds < MONTH) return `${Math.floor(seconds / WEEK)}w`;
  if (seconds < YEAR) return `${Math.floor(seconds / MONTH)}mo`;
  return `${Math.floor(seconds / YEAR)}y`;
}

function absoluteDate(date) {
  if (!date) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function truncate(text, max) {
  if (!max || max <= 0 || text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Build the text shown at the end of the line.
 * `settings` carries the user's configuration plus their git email, so the
 * template can swap their own name for "You".
 */
function annotation(info, settings = {}) {
  if (!info) return '';
  if (info.uncommitted) return 'Uncommitted changes';

  const {
    format = '${author}, ${date} • ${message}',
    dateStyle = 'relative',
    useYou = true,
    maxMessageLength = 60,
    userEmail = null,
    now = new Date(),
  } = settings;

  const isSelf = useYou && userEmail && info.authorMail && info.authorMail === userEmail;

  const values = {
    author: isSelf ? 'You' : info.author,
    date: dateStyle === 'absolute' ? absoluteDate(info.authorTime) : relativeDate(info.authorTime, now),
    message: truncate(info.summary || '', maxMessageLength),
    sha: info.sha,
    shortSha: info.sha.slice(0, 8),
  };

  const text = format.replace(/\$\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match
  );

  // Collapse the gaps left by an empty placeholder (a commit with no message,
  // say) so the annotation never reads as "Ian Han,  • ".
  return text.replace(/\s*•\s*$/, '').replace(/,\s*(?=,|$)/, '').trim();
}

/**
 * Summarise the blame across a block of lines — a function, a class — for the
 * CodeLens above it.
 *
 * Returns the line of text plus the newest commit in the block, so the lens can
 * open that commit when clicked.
 */
function blockSummary(infos, settings = {}) {
  const {
    userEmail = null,
    useYou = true,
    dateStyle = 'relative',
    now = new Date(),
  } = settings;

  const present = infos.filter(Boolean);
  if (!present.length) return null;

  const committed = present.filter((info) => !info.uncommitted);
  if (!committed.length) return { text: 'Uncommitted', newest: null, authors: 0 };

  // Group by email where there is one, since the same person can commit under
  // more than one spelling of their name.
  const authors = new Set();
  let newest = null;

  for (const info of committed) {
    authors.add(info.authorMail || info.author);
    if (!newest || (info.authorTime && (!newest.authorTime || info.authorTime > newest.authorTime))) {
      newest = info;
    }
  }

  const when =
    dateStyle === 'absolute' ? absoluteDate(newest.authorTime) : relativeDate(newest.authorTime, now);

  if (authors.size === 1) {
    const isSelf = useYou && userEmail && newest.authorMail && newest.authorMail === userEmail;
    return { text: `${isSelf ? 'You' : newest.author}, ${when}`, newest, authors: 1 };
  }

  return {
    text: `${authors.size} authors, last changed ${when}`,
    newest,
    authors: authors.size,
  };
}

module.exports = { relativeDate, compactDate, absoluteDate, truncate, annotation, blockSummary };
