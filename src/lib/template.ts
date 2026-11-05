export interface TemplateContext {
  contact: { first_name?: string | null; name?: string | null; username?: string | null };
  fields: Record<string, unknown>;
  vars: Record<string, unknown>;
}

/**
 * Substitui variáveis no texto:
 *   {{first_name}} {{name}} {{username}}
 *   {{field.endereco}}  → campo personalizado do contato
 *   {{var.x}}           → variável da sessão
 *   {{first_name|amigo}} → valor padrão se vazio
 */
export function renderTemplate(text: string, ctx: TemplateContext): string {
  return text.replace(/\{\{\s*([\w.]+)\s*(?:\|([^}]*))?\}\}/g, (_m, path: string, fallback?: string) => {
    let value: unknown;
    if (path.startsWith('field.')) value = ctx.fields[path.slice(6)];
    else if (path.startsWith('var.')) value = ctx.vars[path.slice(4)];
    else value = (ctx.contact as Record<string, unknown>)[path];
    const str = value === undefined || value === null ? '' : String(value);
    return str || (fallback ?? '').trim();
  });
}
