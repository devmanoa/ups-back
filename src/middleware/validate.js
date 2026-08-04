/** Erreur de validation renvoyée en 400 avec le détail des champs fautifs. */
export function badRequest(message, fields = []) {
  return Object.assign(new Error(message), { status: 400, code: 'VALIDATION_ERROR', fields });
}

export function requireFields(source, fields, label = 'corps de requête') {
  const missing = fields.filter((f) => {
    const value = source?.[f];
    return value === undefined || value === null || value === '';
  });

  if (missing.length) {
    throw badRequest(
      `Champs obligatoires manquants dans le ${label}: ${missing.join(', ')}`,
      missing,
    );
  }
}

/** Valide un tableau de colis (poids obligatoire et numérique). */
export function validatePackages(packages) {
  if (!Array.isArray(packages) || packages.length === 0) {
    throw badRequest('Le champ "packages" doit être un tableau contenant au moins un colis.');
  }

  packages.forEach((pkg, i) => {
    const weight = Number(pkg?.weight);
    if (!Number.isFinite(weight) || weight <= 0) {
      throw badRequest(`packages[${i}].weight doit être un nombre supérieur à 0.`);
    }
    for (const dim of ['length', 'width', 'height']) {
      if (pkg[dim] !== undefined && pkg[dim] !== null && pkg[dim] !== '') {
        const v = Number(pkg[dim]);
        if (!Number.isFinite(v) || v <= 0) {
          throw badRequest(`packages[${i}].${dim} doit être un nombre supérieur à 0.`);
        }
      }
    }
  });
}

/** Enveloppe un handler async pour router ses rejets vers le middleware d'erreur. */
export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
