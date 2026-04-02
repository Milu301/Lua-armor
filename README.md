# 🔑 Luarmor Panel

Panel web moderno para gestionar keys de Luarmor. Los usuarios inician sesión con su key, pueden resetear su HWID, ver información de su cuenta y vincular Discord.

## ✨ Funciones

- **Login seguro** con key de Luarmor (verificación directa vía API)
- **Reset de HWID** con límite diario configurable
- **Info de key** — estado, expiración, ejecuciones, HWID vinculado
- **Vincular Discord ID** directamente desde el panel
- **Advertencias de expiración** — avisa 7 días antes
- **Rate limiting** — protección anti-spam
- **Dark mode** — UI gaming moderna

---

## 🚀 Deploy en Railway (5 minutos)

### Paso 1 — Subir el proyecto

Puedes usar GitHub o subir directamente:

```bash
# Inicializar git
git init
git add .
git commit -m "initial commit"

# Crear repo en GitHub y conectar
git remote add origin https://github.com/TU_USER/luarmor-panel.git
git push -u origin main
```

### Paso 2 — Crear proyecto en Railway

1. Ve a [railway.app](https://railway.app) y crea cuenta
2. Clic en **New Project → Deploy from GitHub repo**
3. Selecciona tu repositorio
4. Railway detectará automáticamente el proyecto Node.js

### Paso 3 — Configurar Variables de Entorno

En Railway, ve a tu proyecto → **Variables** → agregar:

| Variable | Valor | Descripción |
|---|---|---|
| `LUARMOR_API_KEY` | `tu_api_key` | De luarmor.net/profile |
| `LUARMOR_PROJECT_ID` | `tu_project_id` | De luarmor.net/projects |
| `SESSION_SECRET` | string aleatorio largo | Mínimo 32 caracteres |
| `DAILY_RESET_LIMIT` | `3` | Límite de resets por día (default 3) |
| `PANEL_NAME` | `Mi Script Hub` | Nombre que aparece en el panel |
| `ACCENT_COLOR` | `8b5cf6` | Color hex sin # (default morado) |
| `NODE_ENV` | `production` | Activa cookies seguras |

> ⚠️ **IMPORTANTE**: Debes whitelist la IP de Railway en [luarmor.net/profile](https://luarmor.net/profile) para que la API funcione.
> Railway puede cambiar la IP. Para evitar problemas usa la opción "Static IP" de Railway o usa un proxy.

### Paso 4 — Deploy

Railway hace deploy automático. Espera ~1 minuto y tu panel está listo en la URL que Railway te asigna.

---

## ⚙️ Configuración local

```bash
# Instalar dependencias
npm install

# Copiar variables de entorno
cp .env.example .env
# Editar .env con tus valores

# Correr en desarrollo
node server.js
# O con auto-reload:
npx nodemon server.js
```

Abre [http://localhost:3000](http://localhost:3000)

---

## 📁 Estructura

```
luarmor-panel/
├── server.js           # Servidor principal Express
├── package.json
├── railway.toml        # Config de Railway
├── .env.example        # Template de variables
├── public/
│   └── css/
│       └── style.css   # Estilos globales
└── views/
    ├── login.ejs       # Página de login
    ├── dashboard.ejs   # Panel principal
    ├── 404.ejs
    ├── error.ejs
    └── partials/
        ├── head.ejs
        └── sidebar.ejs
```

---

## 🔒 Seguridad

- Las keys se verifican directamente contra Luarmor API en cada login
- Las sesiones usan `httpOnly` + `sameSite: lax` cookies
- Rate limiting: 10 intentos de login / 15 min, 30 requests API / min
- Helmet.js con CSP estricto
- Las keys nunca se almacenan en texto plano en la DB (solo en sesión cifrada)

---

## 📝 Notas

- El tracking de resets diarios es **en memoria** (se resetea al reiniciar el servidor). Para producción con alta demanda, considera agregar Redis o una DB.
- Railway hace restart automático al hacer push → los contadores se reinician. Esto es aceptable para uso normal.
- Para mayor persistencia, puedes agregar una base de datos Railway MySQL/PostgreSQL y adaptar `server.js`.

---

## 🎨 Personalización

- **Color de acento**: Cambia `ACCENT_COLOR` en las variables (hex sin #)
- **Nombre del panel**: Cambia `PANEL_NAME`
- **Límite de resets**: Cambia `DAILY_RESET_LIMIT`
- **Estilos**: Edita `public/css/style.css`
