/**
 * Middleware d'erreur unique : toutes les erreurs (validation, OAuth, API UPS)
 * ressortent avec la même forme JSON pour simplifier le front.
 */
export function errorHandler(err, req, res, _next) {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;

  if (status >= 500) {
    console.error(`[ERREUR ${status}] ${req.method} ${req.originalUrl} —`, err.message);
  }

  res.status(status).json({
    success: false,
    error: {
      message: err.message || 'Erreur interne du serveur',
      code: err.code || 'INTERNAL_ERROR',
      ...(err.fields?.length ? { fields: err.fields } : {}),
      ...(err.upsCodes?.length ? { upsCodes: err.upsCodes } : {}),
    },
  });
}

export function notFound(req, res) {
  res.status(404).json({
    success: false,
    error: { message: `Route introuvable: ${req.method} ${req.originalUrl}`, code: 'NOT_FOUND' },
  });
}
