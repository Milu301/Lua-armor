const translations = {
  es: {
    "Overview": "Vista General",
    "Scripts": "Scripts",
    "Connected Accounts": "Cuentas Conectadas",
    "Dashboard": "Panel de Control",
    "Settings": "Ajustes",
    "Global Chat": "Chat Global",
    "Marketplace": "Tienda",
    "Private Chats": "Chats Privados",
    "Report Bug": "Reportar Error",
    "Discord Server": "Servidor de Discord",
    "Free Tier Access": "Acceso Gratuito",
    "Enter your Free Key to check your remaining time:": "Ingresa tu Llave Gratis para revisar tu tiempo restante:",
    "Check Remaining Time": "Ver Tiempo Restante",
    "Status": "Estado",
    "Expiry": "Expiración",
    "Project": "Proyecto",
    "Key Status": "Estado de la Llave",
    "Resets Today": "Reinicios Hoy",
    "Executions": "Ejecuciones",
    "Unlimited resets": "Reinicios Ilimitados",
    "Unlimited": "Ilimitado",
    "Free script access": "Acceso gratis",
    "Free Tier": "Nivel Gratis",
    "total runs": "ejecuciones totales",
    "Your Scripts": "Tus Scripts",
    "Click to copy": "Click para copiar",
    "Copy": "Copiar",
    "Copied!": "¡Copiado!",
    "Save Settings": "Guardar Ajustes",
    "Language": "Idioma",
    "English": "Inglés",
    "Spanish": "Español",
    "Update Profile": "Actualizar Perfil",
    "Discord Connection": "Conexión con Discord",
    "Not connected": "No conectado"
  }
};

window.currentLanguage = window.currentLanguage || 'en';

window.applyTranslations = function() {
  if (window.currentLanguage === 'en') return;
  const dict = translations[window.currentLanguage];
  if (!dict) return;

  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (dict[key]) {
      if (el.tagName === 'INPUT' && el.getAttribute('placeholder')) {
        el.setAttribute('placeholder', dict[key]);
      } else {
        el.innerText = dict[key];
      }
    }
  });
};

document.addEventListener('DOMContentLoaded', window.applyTranslations);
