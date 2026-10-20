// Landmarks in the original 1254 × 1254 artwork. The eye cores include a small
// margin around the iris; the renderer blends the deformation into nearby fur.
export const PLUSH_RIGS = {
  rabbit: {
    eyes: [{ x: 428, y: 875.5, rx: 47, ry: 52.5 }, { x: 832, y: 876, rx: 46, ry: 53 }],
    ears: [
      { bounds: [270, 42, 661, 515], pivot: [456, 488], tip: [479, 120] },
      { bounds: [615, 295, 1118, 634], pivot: [700, 435], tip: [1005, 548] },
    ],
  },
  cat: {
    eyes: [{ x: 465, y: 717.5, rx: 46, ry: 51.5 }, { x: 775.5, y: 716.5, rx: 44.5, ry: 51.5 }],
    ears: [
      { bounds: [223, 264, 505, 568], pivot: [373, 513], tip: [319, 308] },
      { bounds: [741, 269, 1028, 578], pivot: [878, 514], tip: [934, 312] },
    ],
  },
  fox: {
    eyes: [{ x: 492.5, y: 769.5, rx: 39.5, ry: 41.5 }, { x: 750.5, y: 770, rx: 37.5, ry: 41 }],
    ears: [
      { bounds: [287, 266, 574, 617], pivot: [437, 548], tip: [362, 305] },
      { bounds: [675, 264, 964, 620], pivot: [821, 548], tip: [884, 305] },
    ],
  },
  mouse: {
    eyes: [{ x: 499.5, y: 762.5, rx: 44.5, ry: 44.5 }, { x: 739, y: 763, rx: 43, ry: 44 }],
    ears: [
      { bounds: [230, 316, 581, 660], pivot: [445, 578], tip: [387, 364] },
      { bounds: [679, 316, 1028, 662], pivot: [809, 579], tip: [871, 364] },
    ],
  },
  sheep: {
    eyes: [{ x: 517, y: 770, rx: 33, ry: 37 }, { x: 739, y: 770, rx: 33, ry: 37 }],
    ears: [
      { bounds: [207, 630, 404, 826], pivot: [384, 665], tip: [263, 768] },
      { bounds: [865, 626, 1050, 826], pivot: [879, 665], tip: [993, 767] },
    ],
  },
};
