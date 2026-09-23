# Extensión VS Code: arquitectura y contribución

La primera versión empaqueta el motor existente dentro del extension host de escritorio. El JavaScript y dependencias se incluyen en el VSIX, sin Node externo. La CLI permanece disponible y conserva su comportamiento. No se publica automáticamente en Marketplace.

## Componentes

- `src/operations/coordinator.ts`: ciclo de vida independiente de entorno, motor compartido, polling y cierre.
- `src/operations/runtime.ts`: adapter CLI para variables de entorno, estado y review loopback.
- `src/mcp-http.ts`: transporte MCP Streamable HTTP por solicitud, autenticación de sesión, límites de body/concurrencia, validación Host/Origin y cierre ordenado.
- `extension/src/extension.ts`: activación, MCP provider oficial, comandos de apertura y URI handler.
- `extension/src/workbench.ts`: controlador de aplicación; perfiles, credenciales, configuración, catálogo, planificación, acciones revisadas, consultas e integración MCP.
- `extension/src/model.ts`: validación de perfiles, vista de historial por conexión y repositorio de catálogo con control de revisión.
- `extension/src/network.ts`: fetch/Undici con CA/proxy explícitos; no modifica la política TLS global del proceso.
- `extension/src/migration.ts`: importación cifrada de historiales, con bloqueo y marcador de operación incompleta.
- `extension/src/panel.ts` y `extension/media`: puente tipado, webview local con CSP y contenido renderizado como texto.

Cada petición HTTP obtiene su propio McpServer/transporte; comparte servicios y coordinador con el panel. El token MCP es efímero y diferente del PAT. No hay handlers públicos de MCP para aplicar cambios, aprobar ni reconciliar automáticamente. Las herramientas de configuración crean borradores o abren vistas, sin guardar ni ejecutar.

Los perfiles guardan únicamente datos no secretos en globalState y credenciales en SecretStorage. Organization/project son parte de la identidad del perfil; para otro ámbito se crea otro perfil. La revisión de credencial invalida planes antiguos. El store global usa un solo lock para todos los perfiles, pero filtra su historial por connectionId. Cambiar de conexión no evita estados inciertos existentes.

## Desarrollo local

Usa Node 22.13+ en la rama 22, o Node 24+. Desde la raíz:

```sh
npm ci
npm run check
npm run format:check
npm run extension:build
npm run extension:package
```

El VSIX se genera en `artifacts/azure-devops-classic-workbench.vsix`. El empaquetado permite únicamente manifest, README, licencia, bundle y media. No se empaquetan node_modules, fuentes, .env, catálogos locales, pruebas ni estado. El bundle incluye dependencias; `vscode` es la única dependencia externa de aplicación.

La compilación sigue siendo responsabilidad de contribuidores/CI, nunca del usuario final. Conserva los scripts raíz y la CLI al agregar funcionalidades. Mantén contratos de dominio fuera de la API de VS Code; agrega adapters en la extensión.

## Pruebas

`npm test` incluye tests del motor existente, protocolo HTTP con cliente SDK oficial, aislamiento de perfiles, catálogo concurrente, importación de estado, controlador empaquetado con API VS Code simulada y webview con DOM simulado. Las pruebas del controlador usan servicios reales y un fetch sintético; nunca credenciales corporativas.

```sh
npm run extension:build
npm run extension:test
```

El segundo comando descarga y abre VS Code 1.105.1 en un perfil temporal para probar activación, proveedor y comando de panel. Requiere una sesión gráfica funcional. Un fallo de lanzamiento de Electron no debe ocultarse ni contarse como prueba aprobada. La matriz CI debe incluir Windows y macOS con sesión gráfica; ejecutar en Linux requiere un display virtual configurado por el runner.

Aceptación manual antes de distribuir ampliamente: instalar VSIX en Windows sin Node/npm; configurar TLS/credenciales; importar YAML; preparar desde Copilot; revisar/aplicar desde panel; comprobar intento nuevo; probar rollback/recovery y cierre/reapertura. Validar permisos y efectos downstream sobre un release de prueba.

## Compatibilidad y riesgos

El núcleo sigue sin ofrecer transacción PUT+PATCH, control CAS distribuido ni ejecución aislada de tareas. La importación no borra el store de origen: el usuario debe retirar el coordinador antiguo. La identidad de conexión vinculada al hash invalida planes anteriores y puede impedir rollback directo de registros importados de CLI. No reinterpretar esos registros ni reescribir su hash para evitar controles.

El YAML personal vive en globalStorage, se importa como copia y se exporta explícitamente; el editor guarda el texto exacto y evita perder comentarios. No se editan archivos del repositorio silenciosamente. Los cambios externos detectados por revisión requieren recargar; no existe una transacción universal con editores externos durante el rename final.

La primera versión no implementa login Entra interactivo/renovación, proxies con autenticación embebida, coordinación multiequipo ni soporte confirmado de hosts remotos/web. Otros clientes MCP requieren configuración compatible y VS Code abierto. Estas limitaciones deben mantenerse visibles en documentación.

Referencias: [proveedor MCP](https://code.visualstudio.com/api/extension-guides/ai/mcp), [SecretStorage](https://code.visualstudio.com/api/references/vscode-api#SecretStorage), [webviews](https://code.visualstudio.com/api/extension-guides/webview), [workspace trust](https://code.visualstudio.com/api/extension-guides/workspace-trust).
