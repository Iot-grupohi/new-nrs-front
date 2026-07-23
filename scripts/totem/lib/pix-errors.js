export function explainPixError(message) {
  if (message.includes("401 Unauthorized")) {
    return [
      message,
      "",
      "O login do cliente está OK. O erro vem do HiPag (gateway PIX da loja).",
      "",
      "Causas comuns:",
      "- Credenciais HiPag/HiBank da loja inválidas ou expiradas no ambiente",
      "- Staging sem integração PIX ativa para esta unidade",
      "",
      "Ação: solicite ao suporte Lav60 a homologação PIX da loja ou teste em produção.",
    ].join("\n");
  }

  if (message.includes("Conta suspensa") || message.includes("suspensa")) {
    return [
      message,
      "",
      "A loja está suspensa — escolha outra loja com status active.",
    ].join("\n");
  }

  if (message.includes("403")) {
    return [
      message,
      "",
      "Verifique se a loja está active e com HiBank configurado.",
    ].join("\n");
  }

  return message;
}
