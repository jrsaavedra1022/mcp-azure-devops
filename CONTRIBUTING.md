# Contribuir

Usa Node 22.13+ o 24 LTS. Instala con `npm ci`, ejecuta `npm run check` y `npm run format:check`. `npm run demo` abre el recorrido completo con un gateway sintético sin PAT; la URL de revisión se imprime en la terminal.

Antes de desarrollar una función, revisa si el MCP oficial de Microsoft ya la ofrece. Este proyecto complementa Classic Releases y operaciones recurrentes, no pretende duplicar todo Azure DevOps.

## Cambios

1. Describe el caso genérico y las limitaciones del endpoint oficial.
2. Conserva las capas: tools/controller → engine → gateway; estado mediante RecordStore.
3. Actualiza el esquema YAML, ejemplo y documentación cuando cambie el contrato.
4. Añade pruebas de comportamiento: conflicto, permisos, expiración, efectos parciales y resultados inciertos, además del caso exitoso.
5. Mantén compatibilidad con las tools de lectura o documenta la migración.
6. Revisa el diff y el paquete; nunca incluyas `.env`, estados, URLs autenticadas o snapshots corporativos.

Las verificaciones de UI deben cubrir revisión, ejecución y restauración, además de errores. Para tests HTTP se necesita poder escuchar en loopback. No se debe omitir esa prueba silenciosamente si el entorno restringe sockets; ejecutarla en el entorno de CI o con autorización local.

Las contribuciones no pueden añadir escrituras desde tools que eludan la revisión, retries automáticos de deploy, recolección de credenciales en el navegador o bypass de aprobaciones de Azure. Para concurrencia distribuida o nuevas estrategias, presenta primero una decisión de arquitectura con sus garantías reales.

Las pruebas de integración reales son manuales, con una definición de laboratorio y autorización explícita. El código del pipeline, scripts o tasks ejecutados deben revisarse previamente. Un PAT amplio no es una autorización para desplegar recursos reales durante los tests.
