package types

type EKSClusterAdmin struct {
	Username string `yaml:"username" validate:"required"`
	Path     string `yaml:"path"     validate:"required"`
}

type CustomSecret struct {
	SecretName      string `yaml:"secret_name"       validate:"required"`
	Manual          bool   `yaml:"manual"`
	Value           string `yaml:"value"`
	Length          *int   `yaml:"length"             validate:"omitempty,gte=8,lte=128"`
	Special         *bool  `yaml:"special"`
	OverrideSpecial string `yaml:"override_special"`
}
