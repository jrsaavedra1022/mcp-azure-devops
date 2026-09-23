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

## Archivos que pueden entrar a Git

Versiona el código, las pruebas sintéticas, `package-lock.json`, `.env.example`, los ejemplos genéricos y `.vscode/mcp.json` sin credenciales. No excluyas toda la carpeta `.vscode`: la configuración compartida de MCP forma parte del proyecto.

Guarda los catálogos personales como `*.local.yaml` o `*.local.yml`, y las configuraciones personales como `*.local.json` o `*.local.jsonc`. Para snapshots, exportaciones, certificados o copias del estado usa `local/` (ignorado) o una ubicación fuera del repositorio. Un catálogo exportado con un nombre genérico fuera de esas ubicaciones no queda protegido automáticamente. El estado incluye una clave llamada `key` sin extensión: conserva la carpeta completa en una ubicación privada, nunca copies esa clave suelta al repositorio.

Los VSIX, compilaciones, certificados, claves y `releases/preview/` quedan fuera de Git. Las versiones distribuibles se adjuntan a una Release cuando se decida publicarlas. Cada usuario configura sus propias credenciales; no agregues URLs internas, nombres de organización, identificadores de recursos reales, capturas de pantallas corporativas ni respuestas reales de Azure a documentación o fixtures.

Antes de compartir cambios, revisa `git status --short`, `git diff --cached` y `git ls-files -ci --exclude-standard`. El último comando detecta archivos ya versionados que coinciden con exclusiones: `.gitignore` no elimina archivos del índice ni del historial. Una búsqueda por patrones no garantiza la ausencia de secretos; si se detecta una credencial publicada, debe revocarse y tratarse también su presencia en el historial.
