# Seguridad

Reporta vulnerabilidades por el canal privado que configure el propietario del repositorio. No publiques tokens, snapshots reales, valores internos o enlaces de revisión en issues.

Las lecturas originales ocultan valores por defecto. Las operaciones permiten variables con valor string visible y `isSecret: false` u omitido; bloquean siempre `isSecret: true` y valores ocultos o ausentes y almacenan su diff en un registro local cifrado. El PAT y las respuestas completas Azure no se devuelven al panel. Las escrituras y aprobaciones requieren habilitación de proceso y revisión local.

El servidor HTTP escucha en 127.0.0.1 y usa sesión aleatoria, validación de Host/Origin, JSON, CSP y no-store. No está preparado para exponerse por túneles o a una red. El enlace con token concede acceso a la sesión local: protege sus logs y mensajes. La interfaz no aísla procesos hostiles del mismo usuario ni sustituye políticas Azure.

El archivo de clave y los registros deben permanecer bajo permisos del usuario; en Windows verificar ACL. El cifrado no protege frente a acceso conjunto a clave y registros. No sincronizar el estado con Git o una carpeta compartida. No se realizan mutaciones automáticas al recuperar una operación interrumpida.

Para certificados corporativos con Node 24, usa `--use-system-ca` y, si TI lo requiere, `NODE_EXTRA_CA_CERTS` con una CA PEM confiable en el entorno antes de iniciar Node. No deshabilites la validación TLS.

Consulta docs/OPERATIONS.md para límites de concurrencia, scopes, restauración, retención y recuperación de bloqueos.
