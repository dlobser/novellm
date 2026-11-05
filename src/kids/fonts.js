// Google Fonts suited to children's books. `w` lists weights Google serves for the family
// (requesting a weight a family lacks makes Google return an error, so keep these accurate).

export const KID_FONTS = [
  // Easy-reading body fonts
  { name: 'Andika', cat: 'Readable', w: '400;700', fallback: 'sans-serif', note: 'Designed for beginning readers' },
  { name: 'Atkinson Hyperlegible', cat: 'Readable', w: '400;700', fallback: 'sans-serif' },
  { name: 'Lexend', cat: 'Readable', w: '400;600;700', fallback: 'sans-serif' },
  { name: 'Nunito', cat: 'Readable', w: '400;700;800', fallback: 'sans-serif' },
  { name: 'Quicksand', cat: 'Readable', w: '400;600;700', fallback: 'sans-serif' },
  { name: 'Comic Neue', cat: 'Readable', w: '400;700', fallback: 'sans-serif' },
  { name: 'Mali', cat: 'Readable', w: '400;600;700', fallback: 'cursive' },
  { name: 'Literata', cat: 'Storybook serif', w: '400;600;700', fallback: 'serif' },
  { name: 'Lora', cat: 'Storybook serif', w: '400;600;700', fallback: 'serif' },
  { name: 'EB Garamond', cat: 'Storybook serif', w: '400;600;700', fallback: 'serif' },
  { name: 'Merriweather', cat: 'Storybook serif', w: '400;700', fallback: 'serif' },
  // Display / title fonts
  { name: 'Fredoka', cat: 'Playful display', w: '400;600;700', fallback: 'sans-serif' },
  { name: 'Baloo 2', cat: 'Playful display', w: '400;600;800', fallback: 'sans-serif' },
  { name: 'Grandstander', cat: 'Playful display', w: '400;700;900', fallback: 'cursive' },
  { name: 'Sniglet', cat: 'Playful display', w: '400;800', fallback: 'cursive' },
  { name: 'Chewy', cat: 'Playful display', w: '400', fallback: 'cursive' },
  { name: 'Luckiest Guy', cat: 'Playful display', w: '400', fallback: 'cursive' },
  { name: 'Lilita One', cat: 'Playful display', w: '400', fallback: 'cursive' },
  { name: 'Titan One', cat: 'Playful display', w: '400', fallback: 'cursive' },
  { name: 'Bubblegum Sans', cat: 'Playful display', w: '400', fallback: 'cursive' },
  { name: 'Henny Penny', cat: 'Playful display', w: '400', fallback: 'cursive' },
  { name: 'Mouse Memoirs', cat: 'Playful display', w: '400', fallback: 'sans-serif' },
  { name: 'Playfair Display', cat: 'Classic display', w: '400;700;900', fallback: 'serif' },
  // Handwritten
  { name: 'Patrick Hand', cat: 'Handwritten', w: '400', fallback: 'cursive' },
  { name: 'Schoolbell', cat: 'Handwritten', w: '400', fallback: 'cursive' },
  { name: 'Gaegu', cat: 'Handwritten', w: '400;700', fallback: 'cursive' },
  { name: 'Kalam', cat: 'Handwritten', w: '400;700', fallback: 'cursive' },
  { name: 'Caveat', cat: 'Handwritten', w: '400;700', fallback: 'cursive' },
  { name: 'Short Stack', cat: 'Handwritten', w: '400', fallback: 'cursive' },
  { name: 'Amatic SC', cat: 'Handwritten', w: '400;700', fallback: 'cursive' },
];

export function fontInfo(name) {
  return KID_FONTS.find(f => f.name === name) || { name, w: '400', fallback: 'sans-serif' };
}

export function fontStack(name) {
  const f = fontInfo(name);
  return `'${f.name}', ${f.fallback}`;
}

export function fontCssUrl(name) {
  const f = fontInfo(name);
  const fam = f.name.replace(/ /g, '+');
  const w = f.w && f.w !== '400' ? `:wght@${f.w}` : '';
  return `https://fonts.googleapis.com/css2?family=${fam}${w}&display=block`;
}

// Bold weight to use for a family (display fonts with a single weight stay at 400).
export function boldWeight(name) {
  const ws = (fontInfo(name).w || '400').split(';').map(Number);
  return Math.max(...ws);
}
