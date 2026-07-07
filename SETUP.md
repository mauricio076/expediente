# Expediente — Guía de despliegue en Cloudflare

> **Entornos (Wrangler environments):**
> - **Desarrollo (por defecto):** `casos-dev.axlotl.dev` — worker `expediente-dev`,
>   base de datos D1 `expediente-dev`.
> - **Producción (opcional, para más adelante):** `casos.axlotl.dev` — worker
>   `expediente`, base de datos D1 `expediente`.
>
> La zona `axlotl.dev` debe existir en la misma cuenta de Cloudflare; al
> desplegar, Wrangler crea el registro DNS del subdominio y el certificado
> automáticamente (custom domain).

## Despliegue automático (recomendado)

El objetivo por defecto es el **entorno de desarrollo** (`casos-dev.axlotl.dev`).

### A) Script todo-en-uno

```bash
export CLOUDFLARE_API_TOKEN=...     # token con permisos Workers + D1 + Routes
export CLOUDFLARE_ACCOUNT_ID=...    # id de tu cuenta
export APP_PASSWORD=...             # contraseña de la app (solo 1ª vez / al cambiar)
export JWT_SECRET=$(openssl rand -base64 32)
npm ci
npm run deploy:dev                  # -> casos-dev.axlotl.dev   (entorno de desarrollo)
# npm run deploy:prod               # -> casos.axlotl.dev (producción, cuando quieras)
```

`deploy:dev` (en `scripts/deploy.sh`) es idempotente: crea la base de datos
D1 `expediente-dev` si no existe, escribe su `database_id` en `wrangler.toml`,
aplica `schema.sql`, configura los secretos y despliega el worker a
`casos-dev.axlotl.dev`. Internamente usa `wrangler deploy --env dev`.

### B) GitHub Actions

El workflow `.github/workflows/deploy.yml` despliega en cada push a `main`.
Solo necesitas añadir estos *repository secrets* (Settings → Secrets and
variables → Actions):

| Secret | Requerido | Para qué |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | sí | autenticación |
| `CLOUDFLARE_ACCOUNT_ID` | recomendado | seleccionar la cuenta |
| `APP_PASSWORD` | 1ª vez | contraseña de login |
| `JWT_SECRET` | 1ª vez | firma de sesiones |

---

## Despliegue manual (paso a paso)

## Requisitos previos

- Cuenta de Cloudflare (cloudflare.com)
- Node.js 18+ instalado
- Wrangler CLI: ya incluido en `devDependencies`

---

## Paso 1 — Instalar dependencias

```bash
npm install
```

---

## Paso 2 — Crear la base de datos D1 (entorno de desarrollo)

```bash
npx wrangler d1 create expediente-dev
```

Wrangler mostrará algo como:
```
✅ Successfully created DB 'expediente-dev' in region WEUR
Created your new D1 database.
[[d1_databases]]
binding = "DB"
database_name = "expediente-dev"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

**Copia el `database_id`** y pégalo en el bloque `[[env.dev.d1_databases]]` de
`wrangler.toml`:

```toml
[[env.dev.d1_databases]]
binding = "DB"
database_name = "expediente-dev"
database_id = "TU_DATABASE_ID_AQUI"
```

---

## Paso 3 — Crear la tabla en la base de datos

```bash
# Localmente (para desarrollo con `wrangler dev`):
npx wrangler d1 execute expediente --local --file=schema.sql

# En el D1 remoto del entorno dev:
npx wrangler d1 execute expediente-dev --remote --file=schema.sql
```

---

## Paso 4 — Configurar contraseña y secretos (entorno dev)

```bash
# Contraseña de acceso a la app:
npx wrangler secret put APP_PASSWORD --env dev
# Escribe tu contraseña cuando se te pida.

# Clave para firmar las sesiones (genera una aleatoria):
npx wrangler secret put JWT_SECRET --env dev
# Pega cualquier cadena larga y aleatoria, por ejemplo:
# openssl rand -base64 32
```

El usuario por defecto es `admin`. Si quieres cambiarlo, edita el bloque
`[env.dev]` de `wrangler.toml`:
```toml
[env.dev]
vars = { APP_USERNAME = "tu_usuario" }
```

---

## Paso 4bis — Conectar proveedores de nube (opcional)

Estos secretos son opcionales: sin ellos la app funciona igual, solo que la
sección de Fotos/Videos no podrá explorar carpetas de esa nube (se puede
seguir usando "Enlace de un archivo" con enlaces directos/compartidos).

### Google Drive (cuenta de servicio, sin OAuth)

1. En [Google Cloud Console](https://console.cloud.google.com/) crea una
   **cuenta de servicio** (Service Account) en cualquier proyecto, con el rol
   básico "Viewer" (no necesita permisos especiales).
2. Genera una **clave JSON** para esa cuenta de servicio y descárgala.
3. Comparte (como "Lector") las carpetas de Drive que quieras poder explorar
   con el correo de la cuenta de servicio (algo como
   `nombre@proyecto.iam.gserviceaccount.com`).
4. Sube el contenido completo del JSON como secreto:
   ```bash
   npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON --env dev
   # pega el contenido completo del archivo .json descargado
   ```

### Dropbox (OAuth2 con refresh token)

1. Crea una app en la [Dropbox App Console](https://www.dropbox.com/developers/apps)
   → "Create app" → tipo **Scoped access**, acceso a **App folder** o
   **Full Dropbox** (según prefieras), cualquier nombre.
2. En la pestaña **Permissions** de la app, activa los scopes
   `files.metadata.read` y `files.content.read`, y guarda.
3. En la pestaña **Settings**, agrega como **Redirect URI** exactamente:
   `https://casos-dev.axlotl.dev/api/dropbox/callback`
   (y la de producción si aplica: `https://casos.axlotl.dev/api/dropbox/callback`).
4. Copia el **App key** y **App secret** de esa misma pestaña, y súbelos:
   ```bash
   npx wrangler secret put DROPBOX_APP_KEY --env dev
   npx wrangler secret put DROPBOX_APP_SECRET --env dev
   ```
5. En la app, abre **Fotos → Agregar → pestaña Dropbox → "Conectar Dropbox"**
   y autoriza. Queda conectado hasta que lo desconectes desde ahí mismo.

### OneDrive personal (Microsoft Graph, OAuth2 con refresh token)

1. Registra una app en [Azure Portal → App registrations](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)
   → "New registration". En **Supported account types** elige
   **"Personal Microsoft accounts only"** (o la opción que incluya cuentas
   personales) — esta integración es solo para OneDrive personal, no
   SharePoint/organizacional.
2. En **Redirect URI** (tipo Web) agrega exactamente:
   `https://casos-dev.axlotl.dev/api/onedrive/callback`
3. En **Certificates & secrets**, crea un **Client secret** nuevo y copia su
   *value* (solo se muestra una vez).
4. En **API permissions**, agrega el permiso delegado `Files.Read` de
   Microsoft Graph (y `offline_access`, normalmente ya incluido por defecto).
5. Copia el **Application (client) ID** y el **Client secret**, y súbelos:
   ```bash
   npx wrangler secret put ONEDRIVE_CLIENT_ID --env dev
   npx wrangler secret put ONEDRIVE_CLIENT_SECRET --env dev
   ```
6. En la app, abre **Fotos → Agregar → pestaña OneDrive → "Conectar OneDrive"**
   y autoriza.

Tras subir cualquiera de estos secretos hay que volver a desplegar
(`npm run deploy`) para que el worker los tome.

---

## Paso 5 — Desplegar (entorno de desarrollo)

```bash
npm run deploy           # = wrangler deploy --env dev
```

Wrangler publicará el worker en el subdominio de desarrollo:
```
✅ Deployed to https://casos-dev.axlotl.dev
```

> `casos-dev.axlotl.dev` está definido en el bloque `[env.dev]` de `wrangler.toml`
> mediante `routes` con `custom_domain = true`. La zona `axlotl.dev` debe estar
> en tu cuenta de Cloudflare; Wrangler crea el DNS del subdominio y el
> certificado al desplegar.
>
> Para producción (`casos.axlotl.dev`) más adelante: `npm run deploy:prod`.

---

## Desarrollo local

```bash
# Primero crea la tabla local:
npx wrangler d1 execute expediente --local --file=schema.sql

# Inicia el servidor de desarrollo:
npm run dev
```

La app estará en http://localhost:8787

En desarrollo, si `APP_PASSWORD` no está configurada como secret, la app mostrará un error de configuración. Puedes usar un archivo `.dev.vars` para desarrollo:

```bash
# .dev.vars (NO hacer commit de este archivo)
APP_PASSWORD=mi_contraseña_local
JWT_SECRET=dev-secret-local
```

---

## Cambiar el usuario o contraseña

- **Usuario**: edita `APP_USERNAME` en `wrangler.toml` y redespliega con `npm run deploy`
- **Contraseña**: `npx wrangler secret put APP_PASSWORD` y redespliega

---

## Exportar los datos

Desde la app, el botón ↓ en la barra superior descarga todos los datos del expediente como JSON.

También puedes consultarlos directamente en D1:
```bash
npx wrangler d1 execute expediente --remote --command "SELECT updated_at FROM case_data WHERE key='main'"
```

---

## Estructura de archivos

```
src/
  index.ts              # Worker principal (Hono)
  auth.ts               # Firma HMAC-SHA256 para sesiones
  templates/
    app.ts              # HTML de la app (React + JSX inline)
    login.ts            # Página de inicio de sesión
schema.sql              # Esquema de D1 (una sola tabla)
wrangler.toml           # Configuración de Cloudflare
```
