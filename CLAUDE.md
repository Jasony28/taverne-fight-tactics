# Taverne Fight Tactics

- Auto-battler web : serveur Node.js autoritaire (`server.js`, `engine/`) + client Canvas (`public/`).
- `engine/` ne dépend pas du web : il doit rester réutilisable par un futur client Godot (protocole dans `docs/PROTOCOLE.md`).
- Le contenu (`data/*.json`) appartient à l'auteur : ne rien inventer ni renommer sans qu'il le demande.
  L'équilibrage chiffré vit dans `config/balance.json` et `config/pve.json`.
- Le jeu se joue uniquement en paysage : garder l'écran « tourne ton téléphone » et tester les mises en page
  à hauteur de téléphone (environ 844 × 390).
- Règles moteur décidées : `docs/REGLES_MOTEUR.md` et `docs/EFFETS_OBJETS.md`.
- Avant de commiter : `npm test` (règles, reconnexion, 4 parties complètes à 8 bots, partie réseau).
