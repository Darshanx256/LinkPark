export function updateRecent(val) {
  if (!val) return;
  const RECENT_KEY = 'lp_recent';
  let text = typeof val === 'string' ? val : `${val.t || val.title} — ${val.a || val.artist}`;
  let data = typeof val === 'object' ? val : null;

  let recent = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
  recent = recent.filter(r => r.text !== text);
  recent.unshift({ text, data });
  localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, 5)));
}

export function clearRecent() {
  localStorage.removeItem('lp_recent');
}
