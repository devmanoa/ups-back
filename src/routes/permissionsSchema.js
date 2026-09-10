import { Router } from 'express';

/**
 * Catalogue des droits exposé au gestionnaire de profils du Hub.
 *
 * Public et sans authentification : c'est la passerelle Konitys qui le lit
 * pour peupler l'écran « Profils & Droits », sans jeton.
 *
 * Une clé retirée d'ici laisserait des grants orphelins en base : on
 * renomme par migration, on ne supprime pas.
 */
export const permissionsSchemaRouter = Router();

/**
 * `app` est la clé canonique de l'application côté passerelle.
 * Le libellé peut changer sans conséquence ; cette clé, non.
 */
const schema = {
  app: 'ups',
  label: 'UPS Expédition',
  version: 1,
  groups: [
    {
      key: 'access',
      label: "Accès à l'application",
      permissions: [
        { key: 'app.access', label: "Accéder à l'application UPS" },
      ],
    },
    {
      key: 'pages',
      label: 'Pages',
      permissions: [
        { key: 'pages.dashboard.view', label: 'Tableau de bord' },
        { key: 'pages.shipping.view', label: 'Créer une étiquette' },
        { key: 'pages.bulk.view', label: 'Envoi groupé' },
        { key: 'pages.shipments.view', label: 'Liste des envois' },
        { key: 'pages.batches.view', label: 'Lots d’envois' },
        { key: 'pages.anomalies.view', label: 'Anomalies' },
        { key: 'pages.tracking.view', label: 'Suivi de colis' },
        { key: 'pages.rating.view', label: 'Estimation tarifaire' },
        { key: 'pages.transit.view', label: 'Délais d’acheminement' },
        { key: 'pages.locator.view', label: 'Points relais' },
        { key: 'pages.pickup.view', label: 'Enlèvements' },
        { key: 'pages.landed_cost.view', label: 'Coût total à destination' },
        { key: 'pages.paperless.view', label: 'Documents douaniers' },
        { key: 'pages.addresses.view', label: 'Carnet d’adresses' },
        { key: 'pages.package_types.view', label: 'Types de colis' },
        { key: 'pages.activity.view', label: 'Journal d’activité' },
      ],
    },
    {
      key: 'shipments',
      label: 'Envois et étiquettes',
      permissions: [
        { key: 'shipments.view', label: 'Consulter les envois' },
        {
          key: 'shipments.create',
          label: 'Créer une étiquette',
          description: 'Chaque étiquette créée est facturée par UPS.',
        },
        {
          key: 'shipments.create_bulk',
          label: 'Créer un envoi groupé',
          description: 'Jusqu’à 50 étiquettes en une opération.',
        },
        {
          key: 'shipments.void',
          label: 'Annuler une expédition',
          description: 'Distinct de la création : annuler engage un remboursement.',
        },
        { key: 'shipments.refresh', label: 'Actualiser les statuts depuis UPS' },
        { key: 'shipments.label.print', label: 'Imprimer ou télécharger une étiquette' },
      ],
    },
    {
      key: 'comments',
      label: 'Commentaires',
      permissions: [
        { key: 'comments.view', label: 'Lire les commentaires' },
        { key: 'comments.create', label: 'Écrire un commentaire' },
        // Deux clés distinctes : un fil partagé se modère, mais chacun doit
        // pouvoir retirer ce qu'il a écrit sans être modérateur.
        { key: 'comments.delete_own', label: 'Supprimer son propre commentaire' },
        { key: 'comments.delete_any', label: 'Supprimer le commentaire d’un autre' },
      ],
    },
    {
      key: 'addresses',
      label: 'Carnet d’adresses',
      permissions: [
        { key: 'addresses.view', label: 'Consulter le carnet' },
        { key: 'addresses.create', label: 'Ajouter une adresse' },
        { key: 'addresses.edit', label: 'Modifier une adresse' },
        { key: 'addresses.delete', label: 'Archiver ou restaurer une adresse' },
        {
          key: 'addresses.groups.manage',
          label: 'Gérer les groupes d’adresses',
          description: 'Créer, renommer et supprimer les groupes.',
        },
      ],
    },
    {
      key: 'package_types',
      label: 'Types de colis',
      permissions: [
        { key: 'package_types.view', label: 'Consulter les types de colis' },
        { key: 'package_types.create', label: 'Ajouter un type de colis' },
        { key: 'package_types.edit', label: 'Modifier un type de colis' },
        { key: 'package_types.delete', label: 'Archiver ou restaurer un type' },
      ],
    },
    {
      key: 'pickup',
      label: 'Enlèvements',
      permissions: [
        {
          key: 'pickup.create',
          label: 'Programmer un enlèvement',
          description: 'Un enlèvement engage un passage du transporteur.',
        },
        { key: 'pickup.cancel', label: 'Annuler un enlèvement' },
      ],
    },
    {
      key: 'paperless',
      label: 'Documents douaniers',
      permissions: [
        { key: 'paperless.upload', label: 'Téléverser un document chez UPS' },
        { key: 'paperless.link', label: 'Rattacher un document à une expédition' },
      ],
    },
    {
      key: 'directory',
      label: 'Annuaire et mentions',
      permissions: [
        {
          key: 'directory.search',
          label: 'Rechercher un collègue à mentionner',
          description: 'Donne accès aux noms et courriels du realm.',
        },
      ],
    },
    {
      key: 'activity',
      label: 'Journal d’activité',
      permissions: [
        {
          key: 'activity.view',
          label: 'Consulter le journal de toute l’application',
          description: 'Le journal d’un envoi reste visible avec shipments.view.',
        },
      ],
    },
  ],
};

// Public : la passerelle du Hub le lit sans jeton.
permissionsSchemaRouter.get('/', (_req, res) => res.json(schema));

export { schema as permissionsSchema };
