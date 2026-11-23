#include <DHT.h>

#define DHT_PIN 2
#define DHT_TYPE DHT11
#define TRIG_PIN 4
#define ECHO_PIN 5
#define LED_VERDE 8
#define LED_AMARELO 9
#define LED_VERMELHO 10
#define BUZZER 11
#define BOTAO_PIN 12

DHT dht(DHT_PIN, DHT_TYPE);
int ultimoEstadoBotao = HIGH;
unsigned long ultimaLeitura = 0;
unsigned long buzzerSilenciadoAte = 0;
const unsigned long intervaloLeitura = 1000;
const unsigned long duracaoSilencio = 30000;
const unsigned long timeoutRaspberry = 10000;
const unsigned long tempoPortaAberta = 15000;
const float limitePortaAbertaCm = 10.0;
String estadoAtual = "";
String comandoSerial = "";
unsigned long ultimaMensagemPi = 0;
unsigned long inicioPortaAberta = 0;
bool modoLocal = false;
bool portaAberta = false;
float temperaturaAtual = NAN;
bool falhaDht = true;

String estadoLocal() {
  if (falhaDht || temperaturaAtual < 2.0 || temperaturaAtual > 8.0) return "ALARME";
  if (portaAberta && millis() - inicioPortaAberta >= tempoPortaAberta) return "ATENCAO";
  return "OK";
}

void atualizarAtuadores() {
  bool alarme = estadoAtual == "ALARME" || falhaDht;
  bool amarelo = estadoAtual == "ATENCAO";
  if (modoLocal && !alarme) amarelo = (millis() / 500) % 2 == 0;
  digitalWrite(LED_VERDE, estadoAtual == "OK" && !modoLocal ? HIGH : LOW);
  digitalWrite(LED_AMARELO, amarelo ? HIGH : LOW);
  digitalWrite(LED_VERMELHO, alarme ? HIGH : LOW);
  bool buzzerAtivo = alarme && (long)(millis() - buzzerSilenciadoAte) >= 0;
  digitalWrite(BUZZER, buzzerAtivo ? HIGH : LOW);
}

void setup() {
  Serial.begin(9600);
  dht.begin();

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(LED_VERDE, OUTPUT);
  pinMode(LED_AMARELO, OUTPUT);
  pinMode(LED_VERMELHO, OUTPUT);
  pinMode(BUZZER, OUTPUT);
  pinMode(BOTAO_PIN, INPUT_PULLUP);
  digitalWrite(TRIG_PIN, LOW);
  ultimaMensagemPi = millis();
  atualizarAtuadores();
}

void loop() {
  while (Serial.available() > 0) {
    char caractere = Serial.read();
    if (caractere == '\n') {
      comandoSerial.trim();
      if (comandoSerial == "S:OK" || comandoSerial == "S:ATENCAO" || comandoSerial == "S:ALARME") {
        estadoAtual = comandoSerial.substring(2);
        ultimaMensagemPi = millis();
        modoLocal = false;
        atualizarAtuadores();
      }
      comandoSerial = "";
    } else if (caractere != '\r' && comandoSerial.length() < 20) {
      comandoSerial += caractere;
    }
  }

  int estadoBotao = digitalRead(BOTAO_PIN);
  if (estadoBotao == LOW && ultimoEstadoBotao == HIGH) {
    Serial.println("B:1");
    if (estadoAtual == "ALARME" || falhaDht || (modoLocal && estadoLocal() == "ALARME")) {
      buzzerSilenciadoAte = millis() + duracaoSilencio;
    }
  }
  ultimoEstadoBotao = estadoBotao;
  atualizarAtuadores();

  unsigned long agora = millis();
  if (agora - ultimaMensagemPi >= timeoutRaspberry) modoLocal = true;
  if (agora - ultimaLeitura >= intervaloLeitura) {
    ultimaLeitura = agora;

    float temperatura = dht.readTemperature();
    float umidade = dht.readHumidity();
    temperaturaAtual = temperatura;
    falhaDht = isnan(temperatura) || isnan(umidade);

    digitalWrite(TRIG_PIN, LOW);
    delayMicroseconds(2);
    digitalWrite(TRIG_PIN, HIGH);
    delayMicroseconds(10);
    digitalWrite(TRIG_PIN, LOW);
    long duracao = pulseIn(ECHO_PIN, HIGH, 30000);
    float distancia = duracao == 0 ? -1 : duracao * 0.034 / 2.0;
    portaAberta = distancia < 0 || distancia > limitePortaAbertaCm;
    if (portaAberta) {
      if (inicioPortaAberta == 0) inicioPortaAberta = agora;
    } else {
      inicioPortaAberta = 0;
    }
    if (modoLocal) {
      estadoAtual = estadoLocal();
      atualizarAtuadores();
    }

    Serial.print("T:");
    if (isnan(temperatura)) Serial.print("ERR");
    else Serial.print(temperatura, 1);

    Serial.print(",H:");
    if (isnan(umidade)) Serial.print("ERR");
    else Serial.print(umidade, 1);

    Serial.print(",D:");
    Serial.println(distancia, 1);
  }
}