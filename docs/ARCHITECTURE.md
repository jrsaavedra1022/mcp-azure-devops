# Decisiones de arquitectura

## ADR 001: complementar al MCP oficial

Usamos el SDK oficial MCP y REST oficial. No hacemos fork del servidor Microsoft ni duplicamos PRs/Boards/Test Plans. Conservamos las tools originales y añadimos un motor específico de operaciones sobre Classic Releases.

## ADR 002: revisión local obligatoria

Las tools preparan planes; el controlador loopback aplica. El plan fija catálogo, datos y destino. URL con capacidad aleatoria de sesión, fuera del query; cabecera Authorization para API, Origin y Host estrictos, sin CORS, CSP restrictiva y contenido remoto renderizado mediante textContent. El PAT nunca llega al navegador. No se promete resistencia a un agente/proceso malicioso ejecutándose como el mismo usuario.

## ADR 003: estado persistente y errores inciertos

Se registra cada transición antes de mutar. No hay retries de escrituras. Los resultados ambiguos requieren reconciliación; los reintentos de seguimiento son lecturas. Un coordinador local por directorio, bloqueo por release dentro del proceso. La persistencia cifrada puede sustituirse mediante RecordStore. No se ofrece bloqueo distribuido ni transacción entre Azure y el journal local.

## ADR 004: ámbito y destino independientes

Variables de instancia globales y de environment se identifican explícitamente. El redeploy selecciona el environment de esa instancia por mapeo del ID de definición más nombre esperado. Restore conserva el release original, valores anteriores y ausencia original. «Live» y «restaurar» son operaciones distintas.

## ADR 005: compatibilidad conservadora

Fallan los triggers dependientes, condiciones desconocidas y valores con secreto desconocido. No se alteran tareas ni condiciones para forzar compatibilidad. La primera integración con una organización se realiza en un release de prueba. Los snapshots reales nunca se agregan como fixtures.

## Pruebas

Las pruebas unitarias usan un gateway en memoria. Las de protocolo usan el cliente SDK oficial en memoria y stdio. Las HTTP verifican auth, origen y CSP en loopback. La demo cubre el recorrido visual. Agregar pruebas de contrato para cada endpoint nuevo con respuestas sintéticas. Ninguna prueba predeterminada requiere credenciales o modifica Azure.

## Resolución de nombres antes del plan

`CatalogTarget` modela referencias exclusivas por nombre o por ID; `Target` es el contrato canónico persistido, exclusivamente por IDs. `ReleaseGateway.resolveTarget` convierte entre ambos antes de seleccionar el release. `AzureReleaseGateway` realiza las lecturas REST; `target-resolver.ts` resuelve el environment sobre la definición y construye el target. DemoGateway implementa el mismo contrato con datos sintéticos.

El motor valida el allowlist antes de resolver. No ejecuta REST directamente y conserva sus guardas. Resolver no escribe, no conserva una caché y nunca forma parte de apply, refresh o rollback. El límite de paginación falla de forma explícita para no confundir una búsqueda incompleta con unicidad. Se preserva el recorrido sin consultas adicionales para targets históricos con ambos IDs.
