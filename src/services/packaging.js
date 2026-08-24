/**
 * Codes d'emballage UPS (champ `Packaging.Code` en Shipping,
 * `PackagingType.Code` en Rating).
 *
 * Le code `02` — colis client — est le défaut appliqué partout jusqu'ici.
 * Les autres servent aux matériels qui n'entrent pas dans un carton
 * standard : une borne se déclare en palette, pas en colis.
 */
export const PACKAGING_CODES = {
  '01': 'Lettre UPS',
  '02': 'Colis client',
  '03': 'Tube',
  '04': 'Pak UPS',
  '21': 'UPS Express Box',
  '24': 'UPS 25KG Box',
  '25': 'UPS 10KG Box',
  '30': 'Palette',
  '2a': 'Petite Express Box',
  '2b': 'Express Box moyenne',
  '2c': 'Grande Express Box',
};

export const DEFAULT_PACKAGING_CODE = '02';

export function isValidPackagingCode(code) {
  return Object.prototype.hasOwnProperty.call(PACKAGING_CODES, code);
}
