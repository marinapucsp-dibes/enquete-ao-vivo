# Enquete ao vivo

App no estilo Mentimeter: o público responde pelo celular, **sem login e de forma anônima**, e os resultados aparecem no telão em tempo real.

## Telas
| Endereço | Quem usa | O que faz |
|---|---|---|
| `/admin` | Apresentador (notebook) | Cria a sessão, adiciona perguntas, escolhe qual está "no ar", zera, oculta resultados, modera respostas abertas |
| `/tela/CODIGO` | Projetor / telão | QR code + código, gráfico de barras, nuvem de palavras ou mural, atualizando ao vivo |
| `/` | Público (celular) | Digita o código (ou lê o QR) e responde |

## Tipos de pergunta
- **Múltipla escolha** → gráfico de barras animado com %
- **Nuvem de palavras** → até 3 palavras por pessoa; as mais citadas ficam maiores
- **Resposta aberta** → mural de cartões (o apresentador pode ocultar respostas impróprias)

## Anonimato
Nenhum nome, e-mail ou login é pedido. Cada navegador gera um ID aleatório só para impedir voto duplo, e o servidor guarda apenas um *hash* desse ID, que não fica ligado à resposta.

## Rodar no computador
```bash
npm install
npm start
```
Abra http://localhost:3000/admin. Para o público acessar na mesma rede Wi-Fi, abra o telão pelo IP do computador (ex.: `http://192.168.0.10:3000/tela/123456`), assim o QR code aponta para o endereço certo.

## Colocar na internet
Precisa de uma hospedagem que suporte WebSocket (servidor Node que fica ligado), por exemplo **Render**, **Railway** ou **Fly.io**: comando de build `npm install` e de início `npm start`. (Vercel/Netlify sem servidor não servem para o tempo real.)

Os dados ficam em memória e em `data.json`. Em hospedagens gratuitas esse arquivo pode ser apagado quando o servidor reinicia.

### Publicar no Render (passo a passo)
1. Entre em https://render.com com sua conta do GitHub.
2. Clique em **New → Blueprint** e escolha este repositório (o arquivo `render.yaml` já tem toda a configuração).
3. Clique em **Apply**. Em 2–3 minutos o app fica disponível em `https://enquete-ao-vivo-xxxx.onrender.com`.
4. Acesse `/admin` nesse endereço para criar sua apresentação.

Observação: no plano gratuito o servidor "dorme" após 15 min sem uso e leva ~1 min para acordar. Abra o link alguns minutos antes do evento.
