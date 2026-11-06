-- Publicação em carrossel (2 a 10 fotos/vídeos)
alter table autoflow.scheduled_posts drop constraint if exists scheduled_posts_media_type_check;
alter table autoflow.scheduled_posts add constraint scheduled_posts_media_type_check
  check (media_type in ('IMAGE', 'REELS', 'CAROUSEL'));
