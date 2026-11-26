# Règles moteur décidées (étapes 1–2)

## Stats
- `attack_speed` dans les `bonuses` de trait = % de la vitesse de base (0.25 = +25 %).
- Autres clés de `bonuses` : valeurs plates additionnées.

## Sorts — montant final
`montant = values_by_star[étoile] × (1 + (AP − 100)/100 × ap_ratio) + AD × ad_ratio`
(s'applique aux dégâts, soins, boucliers et buffs ; `damage_type` est ignoré pour shield/heal/buff).

- `stun` (type) et `aoe_damage` avec `status_effect: stun` : même traitement (dégâts + statut).
- `dash` : se place sur une case libre adjacente à la cible, inflige les dégâts, applique le statut.
- `buff` : durée 4 s, `montant` ajouté en Armure et RM. Exception `shadownou` : + vitesse d'attaque de montant/100 (en %).
- `summon` (benjador) : 1 Lion max (si vivant, le sort le soigne à 100 %), case libre adjacente.
  PV = values_by_star mis à l'échelle par ap_ratio ; AD = AD du lanceur × ad_ratio ; Armure/RM 40, AS 0.75, portée 1,
  pas de mana, ne compte pas dans les unités survivantes. Le stun s'applique à la cible actuelle.

## Statuts
- `burn` : 3 % des PV max de la cible en dégâts magiques par seconde, ne se cumule pas (rafraîchit la durée).
- `slow` : −30 % vitesse d'attaque et de déplacement.

## Effets de traits
Voir le livrable Gemini étape 1, section 3 (`tavern_toast_shield`, `lazy_gold_gen`, `turbo_ramp_as`,
`rage_below_half_hp`, `midnight_ambush_true_dmg`, `royal_feast_heal`, `creator_blessing_adjacent`,
`assassin_backline_leap`).

## À surveiller en test
- `turbo_ramp_as` (Seigneurs du Bitume) probablement trop fort au palier 4 → piste : +4 % / +7 % par seconde.

## Objets (étape 3)
- Fiche détaillée de chaque `effect_id` : voir `EFFETS_OBJETS.md`.
- 36 recettes : chaque paire de composants (doublons compris) donne un objet. 3 objets max par unité.
- `unique: true` : une unité ne peut pas porter 2 exemplaires du même objet unique.
- Emblème (`grant_trait`) : refusé si l'unité a déjà le trait. Pour les synergies, un même champion
  (même `id`) présent plusieurs fois sur le plateau ne compte qu'une fois.
- Réductions de RM / d'Armure (`aura_shred_mr_zap`, `chain_lightning_shred`, `aura_shred_armor`) :
  non cumulables, on garde la plus forte.
- Brûlure d'objet (`apply_burn_antiheal`) et statut `burn` de sort : deux effets distincts qui peuvent coexister ;
  l'anti-soin ne se cumule pas (on garde le plus fort).
- La prolongation (Overtime, −66 % soins/boucliers) s'applique aussi aux soins et boucliers d'objets.

## Augments (étape 4)
- Palier proposé : un palier tiré par round d'augment (2-1, 3-2, 4-2), le même pour tous les joueurs.
- `trait_emblem` : l'emblème arrive dans l'inventaire d'objets ; mêmes règles que les emblèmes d'objets
  (refusé si l'unité a déjà le trait ; occupe 1 des 3 emplacements d'objet).
- `team_stat` (combat_start) : bonus appliqués au début de chaque combat, comme un palier de trait.
- `grant_gold` / `grant_xp` avec `amount_per_round` sans `rounds` : effet permanent.
- `shop_modifier.cost_odds_bonus` : les points sont ajoutés au coût visé et retirés d'abord au coût 1,
  puis au coût 2, etc. Ne s'applique qu'aux coûts déjà disponibles à ce niveau (probabilité de base > 0).
- `free_rerolls_per_round` et `reroll_cost` se cumulent.
