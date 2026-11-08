-- Inbox: conversa marcada como fechada (pela ação "Marcar conversa como fechada" ou pelo atendente).
-- Volta a ficar aberta quando a pessoa manda mensagem depois disso (last_inbound_at > closed_at).
alter table autoflow.contacts add column if not exists closed_at timestamptz;
