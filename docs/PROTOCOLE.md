# Protocole réseau

Deux transports, mêmes événements :

- **Socket.io** (client web) : `socket.emit(event, payload)`.
- **WebSocket brut** sur `/ws` (client Godot avec `WebSocketPeer`) : chaque message est un JSON
  `{ "event": "...", "payload": { ... } }`, dans les deux sens.

Chaque message client contient `sessionId` (jeton aléatoire gardé par le client). Il sert à se reconnecter
à la même place après une coupure.

## Client → serveur

| Événement | Payload |
|---|---|
| `session:resume` | `{ sessionId }` : reprend la partie liée à la session, sinon le serveur répond `session:none` |
| `room:create` | `{ sessionId, playerName }` |
| `room:join` | `{ sessionId, playerName, roomCode }` |
| `room:ready` | `{ ready }` |
| `room:start` | `{ botDifficulty: "easy" \| "normal" \| "competitive" }` (hôte uniquement) |
| `room:leave` | `{}` |
| `action:buy_unit` | `{ shopSlotIndex }` |
| `action:sell_unit` | `{ unitInstanceId }` |
| `action:move_unit` | `{ unitInstanceId, targetZone: "board" \| "bench", row, col }` (sur le banc, `col` = emplacement 0-8) |
| `action:reroll` / `action:buy_xp` / `action:lock_shop` | `{}` |
| `action:equip_item` | `{ itemIndex, unitInstanceId }` (`itemIndex` = position dans `self.itemBench`) |
| `action:pick_augment` | `{ augmentId }` |
| `action:reroll_augment` | `{ slotIndex }` |
| `action:pick_carousel` | `{ carouselSlotIndex }` |
| `action:scout_player` | `{ targetPlayerId }` |

## Serveur → client

| Événement | Contenu |
|---|---|
| `room:joined` | `{ roomCode, playerId, lobby }` |
| `room:lobby` | état du salon (joueurs, hôte, statut) |
| `game:phase_change` | `{ stage, round, label, roundType, phase, endsAtTimestamp, serverNow, upcoming }` |
| `game:state_sync` | snapshot complet : `self` (or, niveau, XP, unités, banc d'objets, boutique, synergies, augments…), `players` (classement public), `carousel` |
| `game:combat_replay` | `{ matchId, homePlayer, awayPlayer, viewerSide, initialUnits, eventLog, result, stats }` |
| `game:carousel` | emplacements, vague en cours, fin de vague |
| `game:scout` | `{ board, replay }` du joueur observé |
| `game:eliminated` / `game:takeover` / `game:over` | élimination, reprise par un bot, classement final |
| `error:action_rejected` | `{ code, message }` (message en français, affichable tel quel) |

## Journal de combat

`initialUnits` contient la position de départ de chaque unité (arène de 8 × 7, coordonnées odd-r ;
camp 0 en rangées 4-7, camp 1 en rangées 0-3). `eventLog` est trié par `t` (tick de 100 ms). Types
d'événements : `MOVE`, `ATTACK`, `PROJECTILE`, `SPELL_CAST`, `DAMAGE`, `HEAL`, `SHIELD`, `STATUS`, `MANA`,
`MAXHP`, `SUMMON`, `DEATH`, `OVERTIME`, `END`. Si `viewerSide` vaut 1, le client retourne l'arène de 180°
pour que le joueur voie toujours son équipe en bas.
