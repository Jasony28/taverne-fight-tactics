'use strict';
// Grille hexagonale en coordonnées « odd-r » (rangées impaires décalées d'un demi-hex vers la droite).
// Un plateau joueur fait 4 × 7 ; l'arène de combat fait 8 × 7.
// Convention plateau joueur : rangée 0 = ligne avant (côté adversaire), rangée 3 = ligne arrière.

function offsetToCube(row, col) {
  const x = col - (row - (row & 1)) / 2;
  const z = row;
  return { x, y: -x - z, z };
}

function cubeToOffset(x, z) {
  return { row: z, col: x + (z - (z & 1)) / 2 };
}

function distance(a, b) {
  const ca = offsetToCube(a.row, a.col);
  const cb = offsetToCube(b.row, b.col);
  return Math.max(Math.abs(ca.x - cb.x), Math.abs(ca.y - cb.y), Math.abs(ca.z - cb.z));
}

const CUBE_DIRS = [
  [1, -1, 0], [1, 0, -1], [0, 1, -1],
  [-1, 1, 0], [-1, 0, 1], [0, -1, 1],
];

function neighbors(pos, rows, cols) {
  const c = offsetToCube(pos.row, pos.col);
  const out = [];
  for (const [dx, , dz] of CUBE_DIRS) {
    const o = cubeToOffset(c.x + dx, c.z + dz);
    if (o.row >= 0 && o.row < rows && o.col >= 0 && o.col < cols) out.push(o);
  }
  return out;
}

// Toutes les cases à distance <= radius d'un centre.
function within(center, radius, rows, cols) {
  const out = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (distance(center, { row: r, col: c }) <= radius) out.push({ row: r, col: c });
    }
  }
  return out;
}

// Position d'une unité d'un plateau joueur (4×7) dans l'arène (8×7).
// Joueur « local » (home) : rangées 4 à 7 ; adversaire (away) : rangées 0 à 3, en miroir.
function boardToArena(row, col, side) {
  if (side === 0) return { row: 4 + row, col };
  return { row: 3 - row, col: 6 - col };
}

const key = (p) => p.row * 100 + p.col;

module.exports = { offsetToCube, cubeToOffset, distance, neighbors, within, boardToArena, key };
