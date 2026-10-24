-- 画像生成: which model a generation used (anime = Animagine XL 4.0, photo = RealVisXL V5.0). Older rows were all anime.
ALTER TABLE image_generations ADD COLUMN model TEXT NOT NULL DEFAULT 'anime';
