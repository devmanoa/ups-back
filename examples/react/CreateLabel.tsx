/**
 * Exemple React : créer une étiquette depuis l'application appelante.
 *
 * Reprend les conventions du frontend UPS : react-query pour les appels,
 * `ApiError` pour porter le code applicatif, impression via une iframe.
 *
 * **Le navigateur n'appelle jamais `/api/v1` directement** : il passe par le
 * proxy de son propre backend (voir `server-proxy.js`), qui seul détient la
 * clé d'API. Une clé dans du code React se retrouverait dans le bundle et
 * dans l'onglet Réseau, à la portée de n'importe quel visiteur.
 */
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';

/** Adresse du destinataire, telle qu'attendue par l'API. */
interface Address {
  name: string;
  attentionName?: string;
  addressLine1: string;
  city: string;
  postalCode: string;
  country: string;
  phone?: string;
}

interface PackageInput {
  weight: string;
  length?: string;
  width?: string;
  height?: string;
}

interface ShipmentPayload {
  shipTo: Address;
  packages: PackageInput[];
  serviceCode?: string;
  labelFormat?: string;
}

interface ShipmentResult {
  id: string;
  shipmentId: string;
  trackingNumbers: string[];
  labels: { trackingNumber: string | null; base64: string | null; mime: string | null }[];
  labelUrl: string | null;
  totalCharges: number | null;
  currency: string | null;
}

class ApiError extends Error {
  code?: string;
  upsCodes: string[];

  constructor(message: string, code?: string, upsCodes: string[] = []) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.upsCodes = upsCodes;
  }
}

/** Appelle le proxy local, jamais l'API UPS directement. */
async function createShipment(payload: ShipmentPayload): Promise<ShipmentResult> {
  const res = await fetch('/api/ups/shipments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Transmet la session : le proxy refuse un appel non authentifié.
    credentials: 'same-origin',
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => null);

  if (!res.ok || data?.success === false) {
    const upsCodes: string[] = data?.error?.upsCodes ?? [];
    const base = data?.error?.message || `Erreur HTTP ${res.status}`;
    // Le code UPS identifie la cause exacte (120205 = adresse invalide…).
    const message = upsCodes.length ? `${base} [UPS ${upsCodes.join(', ')}]` : base;
    throw new ApiError(message, data?.error?.code, upsCodes);
  }

  return data.data as ShipmentResult;
}

/**
 * Imprime une étiquette base64.
 *
 * Une image chargée seule dans une iframe hérite de la mise en page par
 * défaut du navigateur : l'étiquette UPS (GIF ~800×1200) déborde de la A4 et
 * sort une page blanche. On l'enveloppe donc dans un document contrôlé.
 */
function printLabel(base64: string, mime: string): void {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(frame);

  const doc = frame.contentDocument;
  if (!doc) return;

  doc.open();
  doc.write(`<!doctype html>
    <style>
      @page { margin: 0 }
      body { margin: 0; display: flex; align-items: center; justify-content: center }
      img { max-width: 100%; max-height: 100vh }
    </style>
    <img src="data:${mime};base64,${base64}">`);
  doc.close();

  const img = doc.querySelector('img');
  const launch = () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    // Retrait différé : Safari annule l'impression si l'iframe disparaît
    // pendant que la boîte de dialogue est encore ouverte.
    window.setTimeout(() => frame.remove(), 60_000);
  };

  if (img?.complete) launch();
  else img?.addEventListener('load', launch, { once: true });
}

const EMPTY_ADDRESS: Address = {
  name: '',
  addressLine1: '',
  city: '',
  postalCode: '',
  country: 'FR',
};

/** Champs qu'UPS refuse de traiter s'ils manquent. */
const REQUIRED: { key: keyof Address; label: string }[] = [
  { key: 'name', label: 'Nom' },
  { key: 'addressLine1', label: 'Adresse' },
  { key: 'city', label: 'Ville' },
  { key: 'postalCode', label: 'Code postal' },
  { key: 'country', label: 'Pays' },
];

export function CreateLabel() {
  const [shipTo, setShipTo] = useState<Address>(EMPTY_ADDRESS);
  const [weight, setWeight] = useState('1');
  const [autoPrint, setAutoPrint] = useState(true);

  const mutation = useMutation<ShipmentResult, Error, ShipmentPayload>({
    mutationFn: createShipment,
    onSuccess: (result) => {
      if (!autoPrint) return;
      // Une seule boîte de dialogue par expédition : imprimer colis par
      // colis en enchaînerait autant qu'il y a d'étiquettes.
      const first = result.labels.find((l) => l.base64 && l.mime);
      if (first?.base64 && first.mime) printLabel(first.base64, first.mime);
    },
  });

  const set = (patch: Partial<Address>) => setShipTo((prev) => ({ ...prev, ...patch }));

  // Validé ici comme côté serveur : inutile d'aller jusqu'à UPS pour
  // apprendre qu'il manque la ville.
  const missing = REQUIRED.filter((f) => !shipTo[f.key]);
  const invalidWeight = !(Number(weight) > 0);
  const blocked = missing.length > 0 || invalidWeight || mutation.isPending;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (blocked) return;

    mutation.mutate({
      shipTo,
      packages: [{ weight }],
      serviceCode: '11',
      labelFormat: 'GIF',
    });
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <h2 className="text-lg font-semibold">Créer une étiquette</h2>

      <div className="grid gap-3 sm:grid-cols-2">
        <input
          className="input-field"
          placeholder="Nom du destinataire"
          value={shipTo.name}
          onChange={(e) => set({ name: e.target.value })}
        />
        <input
          className="input-field"
          placeholder="Adresse"
          value={shipTo.addressLine1}
          onChange={(e) => set({ addressLine1: e.target.value })}
        />
        <input
          className="input-field"
          placeholder="Code postal"
          value={shipTo.postalCode}
          onChange={(e) => set({ postalCode: e.target.value })}
        />
        <input
          className="input-field"
          placeholder="Ville"
          value={shipTo.city}
          onChange={(e) => set({ city: e.target.value })}
        />
        <input
          className="input-field"
          placeholder="Pays (FR)"
          value={shipTo.country}
          onChange={(e) => set({ country: e.target.value.toUpperCase() })}
        />
        <input
          className="input-field"
          type="number"
          min="0.1"
          step="0.1"
          placeholder="Poids (kg)"
          value={weight}
          onChange={(e) => setWeight(e.target.value)}
        />
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={autoPrint} onChange={(e) => setAutoPrint(e.target.checked)} />
        Imprimer automatiquement
      </label>

      {missing.length > 0 && (
        <p className="text-sm text-amber-600">
          Champs manquants : {missing.map((f) => f.label).join(', ')}
        </p>
      )}

      <button type="submit" disabled={blocked} className="btn-primary">
        {mutation.isPending ? 'Création…' : "Créer l'étiquette"}
      </button>

      {mutation.isError && (
        <p className="text-sm text-red-600">{mutation.error.message}</p>
      )}

      {mutation.isSuccess && (
        <div className="space-y-2 rounded border border-green-200 bg-green-50 p-3 text-sm">
          <p className="font-medium">
            Étiquette créée — suivi {mutation.data.trackingNumbers[0] || '—'}
          </p>
          {mutation.data.totalCharges != null && (
            <p>
              Coût : {mutation.data.totalCharges} {mutation.data.currency}
            </p>
          )}
          <div className="flex gap-3">
            {/* Passe par le proxy : l'URL renvoyée par l'API est relative au
                backend UPS, que le navigateur ne doit pas atteindre. */}
            <a
              href={`/api/ups/shipments/${encodeURIComponent(mutation.data.id)}/label`}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              Ouvrir l'étiquette
            </a>
            {mutation.data.labels[0]?.base64 && mutation.data.labels[0]?.mime && (
              <button
                type="button"
                className="underline"
                onClick={() =>
                  printLabel(mutation.data.labels[0].base64!, mutation.data.labels[0].mime!)
                }
              >
                Imprimer
              </button>
            )}
          </div>
        </div>
      )}
    </form>
  );
}
