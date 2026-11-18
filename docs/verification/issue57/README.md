# Verificación del modelo (issue #57)

Hecha el 18/11/2026 contra Codex 0.168.0, el binario fijado, sin inferencia:
`npx tsx scripts/verify-models.ts` escribe `model-list.json`.

- **`model/list`** con la cuenta Plus de la Bitácora instalada: el
  predeterminado de Codex es `gpt-6.2-sol` (`isDefault: true`) con razonamiento
  `low`. Hay diez modelos visibles; dos son Astra (`gpt-6.2-astra` y
  `gpt-6-astra`), y Bitácora los deja afuera. Con `includeHidden` aparecen además
  `gpt-reserve` y `codex-auto-review`, que no se muestran.
- **`thread/start`** efímero, en un `CODEX_HOME` temporal y sin cuenta:
  - sin `model`, arranca con `gpt-6.1-sol`: hoy el modelo depende de Codex;
  - con `model: "gpt-6.2-sol"`, devuelve ese modelo;
  - con `config: { model_reasoning_effort: "high" }`, devuelve
    `reasoningEffort: "high"`. `thread/start` no tiene campo `effort`.
- `turn/start` tiene `model` y `effort` en el esquema generado desde el mismo
  binario. No se probó con un turno real, porque gasta cupo de la cuenta.
- El hilo de prueba corre en solo lectura y sin el perfil `agencia`, porque el
  `CODEX_HOME` temporal no tiene preparado el sandbox de Windows. Lo que se mide
  es el modelo y el esfuerzo, no la protección.
- El mail de la cuenta no se guarda en la evidencia.
