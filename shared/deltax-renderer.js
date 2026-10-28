/**
 * Deterministic, repository-native SVG wardrobe for the five DeltaX originals.
 * The source PNG is referenced intact; all added artwork is generated here.
 * No time, random value, token label, or background variation identifies a pet.
 */
import { isHeadwearAllowed } from './deltax-traits.js';

const PALETTES = [
  { main: '#bd555d', light: '#f7c7b8', dark: '#803a48' }, // Cinnabar
  { main: '#87afa5', light: '#e5f1d5', dark: '#497a75' }, // Celadon
  { main: '#6e88b4', light: '#d0e0ed', dark: '#3c557d' }, // Indigo
  { main: '#c695af', light: '#fae0e8', dark: '#875b78' }, // Lotus
  { main: '#c99c57', light: '#fff0c5', dark: '#946b39' }, // Amber
  { main: '#579b83', light: '#cef0ce', dark: '#356755' }, // Jade
  { main: '#9c87bd', light: '#eee0fa', dark: '#6a5486' }, // Wisteria
  { main: '#b7afa1', light: '#fff9e9', dark: '#80756c' }, // Pearl
];

// Coordinates are in the untouched 1254 × 1254 source artwork. Neck ornaments
// sit between the muzzle and paws; separate crown and side-hair anchors avoid
// covering eyes, the nose, the mouth, and the signature cheek star.
const ANCHORS = [
  { head: [420, 584, 1], crown: [620, 570, 1], neck: [620, 1025, 1.02], shadow: [627, 1178, 320] },
  { head: [402, 441, 0.98], crown: [625, 418, 1], neck: [620, 872, 0.97], shadow: [636, 1012, 286] },
  { head: [448, 537, 0.88], crown: [625, 493, 0.86], neck: [623, 875, 0.82], shadow: [642, 1001, 243] },
  { head: [422, 573, 0.82], crown: [620, 521, 0.84], neck: [620, 867, 0.78], shadow: [626, 957, 231] },
  { head: [420, 614, 0.84], crown: [625, 486, 0.87], neck: [622, 866, 0.78], shadow: [627, 961, 242] },
];

const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const group = (content, attributes = '') => `<g ${attributes}>${content}</g>`;
const path = (d, attributes = '') => `<path d="${d}" ${attributes}/>`;
const circle = (cx, cy, r, attributes = '') => `<circle cx="${cx}" cy="${cy}" r="${r}" ${attributes}/>`;
const ellipse = (cx, cy, rx, ry, attributes = '') => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" ${attributes}/>`;
const goldLine = 'fill="none" stroke="url(#dx-gold)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"';
const cloth = 'fill="url(#dx-silk)" stroke="url(#dx-gold)" stroke-width="3" stroke-linejoin="round"';
const fine = 'fill="none" stroke="#fff2cb" stroke-width="2" stroke-linecap="round" opacity=".8"';

function flower(x, y, radius = 28, count = 5, rotation = 0) {
  let petals = '';
  for (let i = 0; i < count; i++) petals += ellipse(0, -radius * .55, radius * .48, radius * .72,
    `fill="url(#dx-petal)" stroke="url(#dx-gold)" stroke-width="1.5" transform="rotate(${360 * i / count})"`);
  return group(petals + circle(0, 0, radius * .18, 'fill="url(#dx-gold)"') +
    circle(-2, -2, radius * .06, 'fill="#fff7d8"'), `transform="translate(${x} ${y}) rotate(${rotation})"`);
}

function beadString(points, radius = 5) {
  return points.map(([x, y]) => circle(x, y, radius, 'fill="url(#dx-pearl)" stroke="#d8c2a1" stroke-width="1"')).join('');
}

function tassel(x, y, length = 65, width = 22) {
  const lines = Array.from({ length: 7 }, (_, i) => {
    const xx = x - width / 2 + (width * i) / 6;
    return path(`M${xx} ${y + 10} Q${xx - 3} ${y + length * .6} ${xx + Math.sin(i) * 3} ${y + length}`, `fill="none" stroke="url(#dx-silk)" stroke-width="3.2" stroke-linecap="round"`);
  }).join('');
  return lines + ellipse(x, y + 7, width / 2 + 2, 8, 'fill="url(#dx-gold)"') + circle(x, y, 5, 'fill="url(#dx-jade)"');
}

/** The same eight motifs are drawn at a readable size on every neckwear type. */
function motif(index, size = 82) {
  let drawing;
  const stroke = 'fill="none" stroke="#fff4d3" stroke-width="4.8" stroke-linecap="round" stroke-linejoin="round"';
  switch (index) {
    case 0: drawing = path('M-36 15 H26 Q43 15 40 1 Q37-10 25-8 Q30-26 12-29 Q-4-33-11-15 Q-26-28-36-13 Q-48 0-35 5 H12 Q26 5 22-5 Q18-12 12-5 M-20 25 H28', stroke); break;
    case 1: drawing = path('M0 31 Q-25 7 0-36 Q25 7 0 31 M0 29 Q-38 19-39-16 Q-14-11 0 29 M0 29 Q38 19 39-16 Q14-11 0 29 M-35 31 Q0 40 35 31', stroke); break;
    case 2: drawing = Array.from({ length: 5 }, (_, i) => ellipse(0, -20, 12, 18, `${stroke} transform="rotate(${72 * i})"`)).join('') + circle(0, 0, 5, 'fill="#fff4d3"'); break;
    case 3: drawing = path('M-6 38 L2-36 M-9 16 H0 M-6-9 H3 M-2-28 H5 M-3 4 Q-31-1-33-21 Q-13-15-3 4 M0-14 Q22-29 36-17 Q22-3 0-14 M-5 24 Q17 6 30 15 Q14 29-5 24', stroke); break;
    case 4: drawing = path('M-42-17 Q-29-34-15-17 T13-17 T41-17 M-42 2 Q-29-15-15 2 T13 2 T41 2 M-42 21 Q-29 4-15 21 T13 21 T41 21 M-32 37 H31', stroke); break;
    case 5: drawing = path('M0 35 C-7 18-27 5-28-10 C-29-24-13-30-3-19 C0-41 28-37 28-17 C47-28 52-6 37 3 C18 15 8 17 0 35 M0 35 Q-14 39-27 31 M-12-5 Q0-15 13-3', stroke); break;
    case 6: drawing = path('M14-35 A37 37 0 1 0 34 22 A32 32 0 0 1 14-35 Z', 'fill="#fff4d3"') + path('M30-31 L34-22 L44-19 L34-15 L30-6 L27-15 L18-19 L27-22 Z', 'fill="#fff4d3"'); break;
    case 7: drawing = path('M-24 9 C-35-23 4-43 26-17 C40 0 16 23-7 14 L-28 35 L-23 14 Z M-12-6 Q4-1 12 14 M-3-27 Q-3-13 8-9 M-11 16 Q-5 29 9 29', stroke) + circle(18, -13, 3, 'fill="#fff4d3"'); break;
    default: throw new RangeError('Unsupported DeltaX motif');
  }
  return group(drawing, `transform="scale(${size / 100})"`);
}

function headwear(index, speciesIndex) {
  switch (index) {
    case 0:
      return group(
        path('M-106 35 L99-35 M-106 45 L93-25', 'fill="none" stroke="url(#dx-gold)" stroke-width="7" stroke-linecap="round"') +
        path('M-71 6 C-121-18-112-64-78-66 C-69-102-25-96-23-65 C15-66 18-20-15-5 Q-44 13-71 6 Z', 'fill="url(#dx-jade)" stroke="url(#dx-gold)" stroke-width="4"') +
        path('M-86-45 Q-75-64-53-51 Q-28-64-25-39 Q-47-15-74-25', fine) +
        path('M-87 4 Q-104 46-84 78', goldLine) + beadString([[-88, 22], [-92, 41], [-89, 61]]) +
        path('M-85 70 Q-112 98-87 113 Q-62 98-85 70Z', 'fill="url(#dx-jade)" stroke="url(#dx-gold)" stroke-width="3"'), 'transform="rotate(-12)"');
    case 1:
      return path('M-103 30 Q-22-15 100-31 M-47 0 L-59-46 M19-17 L37-55', goldLine) +
        flower(-60, -42, 35) + flower(-9, -14, 28, 5, 18) + flower(39, -48, 31, 5, 27) +
        path('M-23 8 Q-28 36-17 55', goldLine) + beadString([[-22, 26], [-19, 47]], 6) +
        path('M-16 57 Q-35 82-16 94 Q4 82-16 57Z', 'fill="url(#dx-jade)" stroke="url(#dx-gold)" stroke-width="2"');
    case 2:
      return path('M-63 48 Q-5 3 58-59 M-35 29 L-75-21 M-6 5 L36 31 M24-26 L-8-61', goldLine) +
        path('M-40 24 Q-89 29-90-12 Q-55-21-40 24 M20-20 Q74-18 73-54 Q43-58 20-20 M-2 7 Q35 63 63 38 Q59 8-2 7', 'fill="url(#dx-jade)" stroke="url(#dx-gold)" stroke-width="2"') +
        flower(-60, -20, 24, 4) + flower(-20, -4, 28, 4, 15) + flower(20, -29, 29, 4) + flower(48, -58, 22, 4, 20) + flower(26, 18, 23, 4, 20) +
        beadString([[-73, 47], [-58, 57], [-42, 57]], 5);
    case 3:
      return path('M-6-8 Q-86-98-119-64 Q-141-27-80 9 Q-141 39-106 66 Q-49 85-6 10Z M6-8 Q86-98 119-64 Q141-27 80 9 Q141 39 106 66 Q49 85 6 10Z', cloth) +
        path('M-15 15 Q-49 52-53 117 L-18 100 L7 120 Q6 60 18 17 M25 16 Q61 53 68 110 L85 89 L116 90 Q83 44 50 7', cloth) +
        path('M-98-46 Q-42-44-8 2 M-99 49 Q-45 34-8 7 M98-46 Q42-44 8 2 M99 49 Q45 34 8 7', fine) +
        ellipse(0, 5, 22, 29, 'fill="url(#dx-jade)" stroke="url(#dx-gold)" stroke-width="5"');
    case 4:
      return path('M-5 2 C-101-89-146-55-101 3 C-165 60-62 99-6 18 M5 2 C101-89 146-55 101 3 C165 60 62 99 6 18', cloth) +
        path('M-12 8 Q-70-37-103-39 M-14 13 Q-58 52-85 47 M12 8 Q70-37 103-39 M14 13 Q58 52 85 47 M-8-6 Q-30-42-36-27 M8-6 Q30-42 36-27', goldLine) +
        ellipse(0, 13, 12, 35, 'fill="url(#dx-jade)" stroke="url(#dx-gold)" stroke-width="3"') +
        beadString([[-94, 11], [-93, 30], [-83, 48], [94, 11], [93, 30], [83, 48]]) +
        path('M-73 55 Q-80 80-62 93', goldLine) + circle(-61, 97, 8, 'fill="url(#dx-pearl)"');
    case 5:
      return path('M-114 1 Q-131-38-94-48 Q-100-85-60-83 Q-45-115-12-91 Q20-121 48-87 Q92-92 93-51 Q134-38 114 1Z', 'fill="url(#dx-jade)" stroke="url(#dx-gold)" stroke-width="5"') +
        path('M-91-10 Q-37-52 0-15 Q35-52 91-10 M-61-50 Q-49-72-23-54 M25-55 Q50-75 65-47', fine) +
        Array.from({ length: 9 }, (_, i) => path(`M${-88 + i * 22} 1 V44`, 'fill="none" stroke="url(#dx-gold)" stroke-width="9" stroke-linecap="round"')).join('') +
        beadString([[-91, -6], [-61, -6], [-31, -6], [0, -6], [31, -6], [61, -6], [91, -6]], 4);
    case 6:
      return path('M-100 10 Q-132-50-103-80 Q-50-62-20 5 M100 10 Q132-50 103-80 Q50-62 20 5', cloth) +
        path('M-67 10 Q-96-78-46-112 Q-4-75 0 3 M67 10 Q96-78 46-112 Q4-75 0 3', cloth) +
        path('M0 12 Q-58-63 0-144 Q58-63 0 12Z', 'fill="url(#dx-jade)" stroke="url(#dx-gold)" stroke-width="4"') +
        path('M-116 10 Q0-11 116 10 L106 35 Q0 13-106 35Z', 'fill="url(#dx-gold)"') +
        beadString([[-77, 20], [-40, 13], [0, 11], [40, 13], [77, 20]], 7) +
        path('M0-109 V-38', fine);
    case 7:
      return path('M-118 12 Q-145-52-105-90 Q-76-130-38-105 Q0-128 38-105 Q76-130 105-90 Q145-52 118 12Z', cloth) +
        ellipse(-104, -73, 26, 31, 'fill="url(#dx-petal)" stroke="url(#dx-gold)" stroke-width="4"') +
        ellipse(104, -73, 26, 31, 'fill="url(#dx-petal)" stroke="url(#dx-gold)" stroke-width="4"') +
        circle(-55, -60, 33, 'fill="url(#dx-pearl)" stroke="url(#dx-gold)" stroke-width="6"') +
        circle(55, -60, 33, 'fill="url(#dx-pearl)" stroke="url(#dx-gold)" stroke-width="6"') +
        circle(-51, -57, 13, 'fill="url(#dx-jade)"') + circle(51, -57, 13, 'fill="url(#dx-jade)"') +
        circle(-55, -63, 4, 'fill="#fffdf1"') + circle(47, -63, 4, 'fill="#fffdf1"') +
        path('M-18-29 Q0-43 18-29 L0-8Z', 'fill="url(#dx-gold)"') +
        (speciesIndex === 3
          // A closed fabric brim covers the root of the forelock. Leaving this
          // opening transparent made the mouse's hair appear to pierce the cap.
          ? path('M-95 10 Q0-20 95 10 Q0 47-95 10Z', 'fill="url(#dx-silk)" stroke="#fff0d9" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"')
          : path('M-95 10 Q0-20 95 10 M-85 14 Q0 47 85 14', 'fill="none" stroke="#fff0d9" stroke-width="14" stroke-linecap="round"')) +
        path('M-16-105 Q0-126 16-105 Q0-77-16-105Z', 'fill="url(#dx-jade)" stroke="url(#dx-gold)" stroke-width="3"') +
        tassel(-112, 13, 70, 18) + tassel(112, 13, 70, 18);
    default: throw new RangeError('Unsupported DeltaX headwear');
  }
}

function neckwear(index, motifIndex) {
  const embroidery = motif(motifIndex, 104);
  const roundEmbroidered = (radius = 54) => circle(0, 16, radius, 'fill="url(#dx-silk)" stroke="url(#dx-gold)" stroke-width="4"') + group(embroidery, 'transform="translate(0 16)"');
  const cord = path('M-157-39 Q-100-4-52 0 M157-39 Q100-4 52 0', 'fill="none" stroke="url(#dx-silk)" stroke-width="12" stroke-linecap="round"') +
    path('M-157-42 Q-100-7-52-3 M157-42 Q100-7 52-3', fine);
  switch (index) {
    case 0:
      return cord + path('M-37-40 Q-98-93-110-45 Q-109-14-68-16 Q-111 19-77 39 Q-44 52-28 16 M37-40 Q98-93 110-45 Q109-14 68-16 Q111 19 77 39 Q44 52 28 16', 'fill="none" stroke="url(#dx-silk)" stroke-width="17" stroke-linecap="round"') +
        path('M0-63 L68 0 L0 69 L-68 0Z', 'fill="url(#dx-silk)" stroke="url(#dx-gold)" stroke-width="5"') +
        group(embroidery, 'transform="translate(0 0) scale(.9)"') + tassel(-26, 67, 58) + tassel(26, 67, 58);
    case 1:
      return path('M-190-51 Q0 6 190-51 L184 2 Q20 46-185 0Z', cloth) +
        path('M-41 24 Q-79 65-65 126 L-24 107 L9 124 Q25 64 36 23 M36 12 Q84 22 110 90 L141 61 L163 62 Q137 2 62-8', cloth) +
        path('M-170-35 Q0 15 167-35 M-52 48 Q-34 67-38 105 M73 13 Q114 27 126 64', fine) +
        roundEmbroidered(51);
    case 2:
      return path('M-173-57 Q-204-19-177 13 Q-190 53-145 65 Q-124 104-83 80 Q-47 117 0 76 Q47 117 83 80 Q124 104 145 65 Q190 53 177 13 Q204-19 173-57 Q0 13-173-57Z', cloth) +
        path('M-165-37 Q-170 18-137 32 Q-125 68-85 57 Q-47 84 0 55 Q47 84 85 57 Q125 68 137 32 Q170 18 165-37', fine) +
        beadString([[-151, 60], [-92, 81], [0, 84], [92, 81], [151, 60]], 6) +
        roundEmbroidered(53);
    case 3:
      return cord + path('M-42-38 Q0-19 42-38 L63 55 Q58 97 0 109 Q-58 97-63 55Z', cloth) +
        path('M-48-30 Q0-10 48-30 M-47-22 Q0-2 47-22 M-30-30 Q-66-61-70-33 Q-63-13-32-24 M30-30 Q66-61 70-33 Q63-13 32-24', goldLine) +
        path('M-45-10 Q-53 49-42 70 M45-10 Q53 49 42 70', fine) +
        group(embroidery, 'transform="translate(0 42)"') + tassel(0, 109, 53, 25);
    case 4:
      return cord + circle(0, 22, 69, 'fill="url(#dx-jade)" stroke="url(#dx-gold)" stroke-width="6"') +
        circle(0, 22, 57, 'fill="none" stroke="#fff0c4" stroke-width="2"') +
        group(embroidery, 'transform="translate(0 22)"') +
        circle(0, -42, 10, 'fill="url(#dx-gold)"') +
        path('M-47-12 Q-53 0-52 20', 'fill="none" stroke="#efffe6" stroke-width="5" stroke-linecap="round" opacity=".7"') +
        tassel(0, 93, 55, 20);
    case 5:
      return cord + path('M-40-39 H40 L67-8 V54 L40 86 H-40 L-67 54 V-8Z', 'fill="url(#dx-pearl)" stroke="url(#dx-gold)" stroke-width="5"') +
        path('M-33-24 H33 L51 1 V47 L32 70 H-32 L-51 47 V1Z', 'fill="url(#dx-silk)" stroke="#e8f0f3" stroke-width="4"') +
        group(embroidery, 'transform="translate(0 21)"') +
        beadString([[-53, -17], [53, -17], [-53, 58], [53, 58]], 4) +
        circle(0, 94, 8, 'fill="url(#dx-pearl)" stroke="url(#dx-gold)" stroke-width="2"');
    case 6:
      return path('M-169-52 Q0 4 169-52 L138 57 Q78 108 0 113 Q-78 108-138 57Z', cloth) +
        path('M-148-32 Q0 20 148-32 L121 46 Q70 91 0 94 Q-70 91-121 46Z', fine) +
        path('M-126-19 L-103 6 L-126 31 L-147 6Z M126-19 L103 6 L126 31 L147 6Z M-94 45 L-72 66 L-51 45 M94 45 L72 66 L51 45', fine) +
        group(embroidery, 'transform="translate(0 31) scale(1.12)"') +
        beadString([[-105, 77], [-57, 102], [0, 117], [57, 102], [105, 77]], 5);
    case 7:
      return cord + path('M-68-30 Q-91-69-122-37 Q-146-11-115 10 V57 Q-78 94 0 94 Q78 94 115 57 V10 Q146-11 122-37 Q91-69 68-30 Q0-49-68-30Z', 'fill="url(#dx-gold)" stroke="#b88942" stroke-width="3"') +
        path('M-76-12 Q0-32 76-12 V54 Q0 80-76 54Z', 'fill="url(#dx-silk)" stroke="#fff1bd" stroke-width="4"') +
        group(embroidery, 'transform="translate(0 23)"') +
        circle(-108, -17, 8, 'fill="url(#dx-jade)"') + circle(108, -17, 8, 'fill="url(#dx-jade)"') +
        tassel(-55, 92, 48, 16) + tassel(55, 92, 48, 16);
    default: throw new RangeError('Unsupported DeltaX neckwear');
  }
}

function definitions(p) {
  return `<defs>
    <linearGradient id="dx-gold" x1="0" y1="0" x2=".8" y2="1"><stop stop-color="#8e6436"/><stop offset=".24" stop-color="#e4ba70"/><stop offset=".46" stop-color="#fff0b4"/><stop offset=".68" stop-color="#bf914c"/><stop offset="1" stop-color="#e8c787"/></linearGradient>
    <linearGradient id="dx-silk" x1="0" y1="0" x2=".7" y2="1"><stop stop-color="${p.light}"/><stop offset=".28" stop-color="${p.main}"/><stop offset=".51" stop-color="${p.light}"/><stop offset=".69" stop-color="${p.main}"/><stop offset="1" stop-color="${p.dark}"/></linearGradient>
    <radialGradient id="dx-jade" cx=".3" cy=".23" r=".8"><stop stop-color="${p.light}"/><stop offset=".43" stop-color="${p.main}"/><stop offset="1" stop-color="${p.dark}"/></radialGradient>
    <radialGradient id="dx-petal" cx=".32" cy=".15" r=".9"><stop stop-color="#fff9e7"/><stop offset=".38" stop-color="${p.light}"/><stop offset="1" stop-color="${p.main}"/></radialGradient>
    <radialGradient id="dx-pearl" cx=".31" cy=".25" r=".83"><stop stop-color="#fffef5"/><stop offset=".42" stop-color="#f4eadb"/><stop offset=".8" stop-color="#d9c9b5"/><stop offset="1" stop-color="#b8a48d"/></radialGradient>
    <radialGradient id="dx-backdrop" cx=".5" cy=".45" r=".7"><stop stop-color="#fffdf5"/><stop offset="1" stop-color="#eee6db"/></radialGradient>
    <filter id="dx-ornament-shadow" x="-40%" y="-40%" width="180%" height="200%"><feDropShadow dx="1" dy="6" stdDeviation="5" flood-color="#725541" flood-opacity=".23"/></filter>
    <filter id="dx-ground-blur" x="-30%" y="-250%" width="160%" height="600%"><feGaussianBlur stdDeviation="14"/></filter>
  </defs>`;
}

/**
 * @param {{traits:{speciesIndex:number,headwear:number,neckwear:number,palette:number,motif:number},baseImageHref:string,size?:number,transparent?:boolean}} options
 * @returns {string} Standalone SVG, embedding a caller-provided PNG data URI.
 */
export function renderDeltaXPortrait({ traits, baseImageHref, lionCapImageHref, size = 1254, transparent = false }) {
  for (const [key, max] of [['speciesIndex', 4], ['headwear', 7], ['neckwear', 7], ['palette', 7], ['motif', 7]]) {
    if (!Number.isInteger(traits?.[key]) || traits[key] < 0 || traits[key] > max) throw new RangeError(`Invalid DeltaX trait: ${key}`);
  }
  if (!isHeadwearAllowed(traits.speciesIndex, traits.headwear)) throw new RangeError('Lion Cap is exclusive to Cat.');
  if (!Number.isInteger(size) || size < 128 || size > 4096) throw new RangeError('DeltaX image size must be between 128 and 4096');
  if (typeof baseImageHref !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(baseImageHref)) throw new TypeError('A self-contained PNG data URI is required');
  const lionCap = traits.speciesIndex === 1 && traits.headwear === 7;
  if (lionCap && (typeof lionCapImageHref !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(lionCapImageHref))) throw new TypeError('Approved lion-cap cat PNG data URI is required');
  const a = ANCHORS[traits.speciesIndex];
  const h = traits.headwear >= 5 ? a.crown : a.head;
  const n = lionCap ? [620, 1015, 1.02] : a.neck;
  const p = PALETTES[traits.palette];
  const atmosphere = transparent ? '' : `<rect width="1254" height="1254" fill="url(#dx-backdrop)"/>
    <circle cx="627" cy="714" r="455" fill="none" stroke="#dfcfac" stroke-width="2" opacity=".38"/>
    <circle cx="627" cy="714" r="443" fill="none" stroke="#dfcfac" stroke-width="1" opacity=".24"/>
    ${path('M128 809 Q166 772 204 807 Q233 830 258 803 M991 409 Q1020 381 1050 406 Q1078 427 1105 402', 'fill="none" stroke="#d5c29c" stroke-width="4" stroke-linecap="round" opacity=".24"')}
    ${ellipse(a.shadow[0], a.shadow[1], a.shadow[2], 18, 'fill="#7c6557" opacity=".16" filter="url(#dx-ground-blur)"')}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${size}" height="${size}" viewBox="0 0 1254 1254" role="img" aria-label="DeltaX Chinese wardrobe portrait">
    ${definitions(p)}${atmosphere}
    <image href="${esc(lionCap ? lionCapImageHref : baseImageHref)}" x="0" y="0" width="1254" height="1254"/>
    <g transform="translate(${n[0]} ${n[1]}) scale(${n[2]})" filter="url(#dx-ornament-shadow)">${neckwear(traits.neckwear, traits.motif)}</g>
    ${lionCap ? '' : `<g transform="translate(${h[0]} ${h[1]}) scale(${h[2]})" filter="url(#dx-ornament-shadow)">${headwear(traits.headwear, traits.speciesIndex)}</g>`}
  </svg>`;
}

export const DELTAX_RENDERER_VERSION = 'deltax-chinese-wardrobe-v2';
