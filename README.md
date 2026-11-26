# Taverne Fight Tactics

Auto-battler web multijoueur de 1 à 8 joueurs. Les places libres sont prises par des bots.
Univers fantasy humoristique tiré de la bande : 29 champions, 7 origines, 6 classes, 36 objets, 26 augments.

Le jeu se joue **uniquement à l'horizontale**. En portrait, un écran demande de tourner le téléphone, et le
bouton plein écran verrouille l'orientation en paysage là où le navigateur le permet.

## Lancer le jeu

```bash
npm install
npm start            # http://localhost:3000
```

- `PORT` : port HTTP (3000 par défaut).
- `TIME_SCALE` : accélère les minuteurs, par exemple `TIME_SCALE=4 npm start` pour tester vite.

Pour jouer entre amis, le serveur doit être accessible depuis Internet (Render, Railway, Fly.io, un VPS…).
Ce n'est **pas** un site statique : GitHub Pages ne suffit pas, il faut un serveur Node.js qui tourne en continu.

## Tests

```bash
npm test
```

| Test | Ce qu'il vérifie |
|---|---|
| `test/rules.test.js` | Banc plein et fusion, fusions 2★/3★, reventes, objets uniques, emblèmes, géométrie hexagonale |
| `test/reconnect.test.js` | Reprise par un bot après 15 s de déconnexion, puis retour du joueur |
| `test/fullgame.test.js` | 4 parties complètes à 8 bots, avec contrôle des invariants (limite du plateau, banc, objets, or) |
| `test/network.test.js` | Partie accélérée via le réseau : un client Socket.io et un client WebSocket brut (comme Godot) |

## Organisation

```
config/balance.json   Tables d'XP, probabilités, pool, revenus, dégâts, minuteurs, réglages des bots
config/pve.json       Monstres neutres des manches PvE et butin (modifiables librement)
data/*.json           Contenu du jeu : traits, champions, objets, augments
docs/                 Cahier des charges, règles moteur, fiche des effets d'objets, protocole réseau
engine/               Logique pure, sans dépendance au web (réutilisable telle quelle par un client Godot)
  GameRoom.js         Machine à états : manches, économie, carrousel, augments, appariements, éliminations
  ShopManager.js      Pool partagé, tirages pondérés, achats, reventes, fusions
  TraitManager.js     Synergies actives et bonus
  ItemManager.js      Recettes, règles d'équipement, emblèmes
  CombatSimulator.js  Combat déterministe en ticks de 100 ms et journal d'événements
  BotAI.js            Économie, achats, niveaux, placement, objets, augments, carrousel
  HexGrid.js, Rng.js  Géométrie hexagonale (odd-r) et aléatoire à graine
server.js             HTTP + Socket.io + WebSocket brut sur /ws
public/               Client navigateur (Canvas 2D)
```

## Ajouter les images

Déposer les fichiers aux chemins déjà prévus dans `data/*.json`. Ils sont affichés automatiquement, et en
attendant le jeu montre les initiales :

- portraits des champions : `public/assets/portraits/<id>.png` (carrés, 256×256 conseillé) ;
- modèles 3D Tripo : `public/assets/models3d/<id>.glb` (utilisés par le futur client Godot) ;
- icônes : `public/assets/traits/<id>.png` et `public/assets/items/<id>.png`.

## Raccourcis clavier

`D` actualiser la boutique · `F` acheter de l'XP · `E` vendre l'unité sous le curseur ·
`W` déployer ou rappeler l'unité sous le curseur · `Échap` fermer la fiche ou quitter le scouting.
Pour vendre une unité, on peut aussi la glisser sur la boutique.
