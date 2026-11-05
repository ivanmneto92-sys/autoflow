/** Erro com status HTTP para as rotas do painel (o handler de /app/* devolve { error: message }). */
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
