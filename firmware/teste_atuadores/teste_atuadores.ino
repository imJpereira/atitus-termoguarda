#define LED_VERDE 8
#define LED_AMARELO 9
#define LED_VERMELHO 10
#define BUZZER 11
#define BOTAO 12

int ultimoEstadoBotao = HIGH;

void setup() {
  Serial.begin(9600);

  pinMode(LED_VERDE, OUTPUT);
  pinMode(LED_AMARELO, OUTPUT);
  pinMode(LED_VERMELHO, OUTPUT);
  pinMode(BUZZER, OUTPUT);
  pinMode(BOTAO, INPUT_PULLUP);

  digitalWrite(LED_VERDE, LOW);
  digitalWrite(LED_AMARELO, LOW);
  digitalWrite(LED_VERMELHO, LOW);
  digitalWrite(BUZZER, LOW);

  Serial.println("Testando LED verde...");
  digitalWrite(LED_VERDE, HIGH);
  delay(600);
  digitalWrite(LED_VERDE, LOW);

  Serial.println("Testando LED amarelo...");
  digitalWrite(LED_AMARELO, HIGH);
  delay(600);
  digitalWrite(LED_AMARELO, LOW);

  Serial.println("Testando LED vermelho...");
  digitalWrite(LED_VERMELHO, HIGH);
  delay(600);
  digitalWrite(LED_VERMELHO, LOW);

  Serial.println("Testando buzzer...");
  digitalWrite(BUZZER, HIGH);
  delay(400);
  digitalWrite(BUZZER, LOW);

  Serial.println("Comandos seriais: 1=Verde, 2=Amarelo, 3=Vermelho, 4=Buzzer, 0=Desligar tudo");
}

void loop() {
  if (Serial.available() > 0) {
    char cmd = Serial.read();
    if (cmd == '1') {
      digitalWrite(LED_VERDE, !digitalRead(LED_VERDE));
      Serial.println("LED verde alternado");
    } else if (cmd == '2') {
      digitalWrite(LED_AMARELO, !digitalRead(LED_AMARELO));
      Serial.println("LED amarelo alternado");
    } else if (cmd == '3') {
      digitalWrite(LED_VERMELHO, !digitalRead(LED_VERMELHO));
      Serial.println("LED vermelho alternado");
    } else if (cmd == '4') {
      digitalWrite(BUZZER, !digitalRead(BUZZER));
      Serial.println("Buzzer alternado");
    } else if (cmd == '0') {
      digitalWrite(LED_VERDE, LOW);
      digitalWrite(LED_AMARELO, LOW);
      digitalWrite(LED_VERMELHO, LOW);
      digitalWrite(BUZZER, LOW);
      Serial.println("Tudo desligado");
    }
  }

  int estadoBotao = digitalRead(BOTAO);
  if (estadoBotao != ultimoEstadoBotao) {
    delay(50);
    estadoBotao = digitalRead(BOTAO);
    if (estadoBotao != ultimoEstadoBotao) {
      ultimoEstadoBotao = estadoBotao;
      if (estadoBotao == LOW) {
        Serial.println("Botao: LOW (pressionado)");
      } else {
        Serial.println("Botao: HIGH (solto)");
      }
    }
  }
}
