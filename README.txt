PIXEL KNIGHT ONLINE DUEL
========================

COSA È
------
Versione multiplayer online 1 contro 1 in prima persona.
Due giocatori entrano nella stessa stanza privata tramite un codice di 6 caratteri.

CARATTERISTICHE
---------------
- Duelli online 1v1
- Prima persona
- Mouse-look
- Attacco singolo con click sinistro
- Parata tenendo premuto il tasto destro
- Vita e stamina sincronizzate dal server
- Server controlla distanza, angolo, cooldown e danni
- Best of 5: vince chi arriva per primo a 3 round
- Armeria pre-duello:
  * Spada gratuita
  * Arco: 70 monete, include 8 frecce
  * 12 frecce aggiuntive: 20 monete
- Inventario con I
- Arena medievale 3D
- Illuminazione, ombre morbide, nebbia, torri, bracieri
- Three.js 0.186.0
- Socket.IO 4.8.3

COMANDI
-------
WASD        Movimento
Mouse       Guarda
Shift       Corsa
Click SX    Un singolo attacco
Click DX    Tieni premuto per parare
I           Inventario
Esc         Libera il mouse / chiudi inventario

COME PROVARLO SUL TUO PC
------------------------
1. Installa Node.js 20 o superiore.
2. Estrai questa cartella.
3. Apri il terminale nella cartella.
4. Esegui:
   npm install
   npm start
5. Apri:
   http://localhost:3000

Per provare un duello sullo stesso PC, apri due finestre del browser.
Per giocare con un amico via Internet devi pubblicare il server.

PUBBLICAZIONE ONLINE CON RENDER
--------------------------------
Nel pacchetto c'è render.yaml.
Procedura tipica:
1. Carica questa cartella in un repository GitHub.
2. Su Render crea un nuovo Blueprint/Web Service dal repository.
3. Render usa automaticamente:
   npm install
   npm start
4. Render ti fornisce un URL https pubblico.
5. Tu e il tuo amico aprite lo stesso URL.
6. Uno crea la stanza e comunica il codice all'altro.

NOTA
----
La chat non può assegnare direttamente a questo pacchetto un dominio pubblico o tenere
un server Node.js permanentemente acceso. Il software è però già strutturato per essere
pubblicato come Web Service.
